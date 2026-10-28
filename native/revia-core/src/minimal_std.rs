use std::{
    cell::RefCell,
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    panic::{self, AssertUnwindSafe, catch_unwind},
    path::{Path, PathBuf},
    process,
    sync::atomic::{AtomicU64, Ordering},
    sync::{Mutex, OnceLock},
    time::Instant,
};

use crate::{
    canonical_json::quote,
    digest::sha256_hex,
    vm::{CapabilityBridge, CapabilityResponse, VmValue, serialize_vm_value},
};

pub const MINIMAL_STD_REQUEST_SCHEMA: &str = "re.native-minimal-std-request@0.1.0";
pub const MINIMAL_STD_PROFILE: &str = "re.native-minimal-std@0.1.0";
pub const HOST_REQUEST_SCHEMA: &str = "re.native-host-request@0.1.0";
pub const HOST_PROFILE: &str = "re.native-server-host@0.1.0";
const MAX_VALUE_DEPTH: usize = 128;
const MAX_COLLECTION_ITEMS: usize = 1_048_576;
const MAX_OUTPUT_BYTES: usize = 1_048_576;
const MAX_RANDOM_BYTES: usize = 4096;
static HOST_PANIC_HOOK_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static HOST_WRITE_NONCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum StdOperation {
    BytesByteCount,
    BytesConcat,
    BytesDecodeUtf8,
    ListAppend,
    ListConcat,
    ListLength,
    ResultIsErr,
    ResultIsOk,
    TextConcat,
    TextEncodeUtf8,
    TextScalarCount,
}

impl StdOperation {
    pub fn name(self) -> &'static str {
        match self {
            Self::BytesByteCount => "std.bytes.byte_count",
            Self::BytesConcat => "std.bytes.concat",
            Self::BytesDecodeUtf8 => "std.bytes.decode_utf8",
            Self::ListAppend => "std.list.append",
            Self::ListConcat => "std.list.concat",
            Self::ListLength => "std.list.length",
            Self::ResultIsErr => "std.result.is_err",
            Self::ResultIsOk => "std.result.is_ok",
            Self::TextConcat => "std.text.concat",
            Self::TextEncodeUtf8 => "std.text.encode_utf8",
            Self::TextScalarCount => "std.text.scalar_count",
        }
    }

    fn argument_names(self) -> &'static [&'static str] {
        match self {
            Self::BytesByteCount
            | Self::BytesDecodeUtf8
            | Self::ResultIsErr
            | Self::ResultIsOk
            | Self::TextEncodeUtf8
            | Self::TextScalarCount => &["value"],
            Self::ListLength => &["values"],
            Self::BytesConcat | Self::ListConcat | Self::TextConcat => &["left", "right"],
            Self::ListAppend => &["value", "values"],
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StdValue {
    Unit,
    Bool(bool),
    Int(String),
    Text(String),
    Bytes(Vec<u8>),
    List(Vec<StdValue>),
    Record(BTreeMap<String, StdValue>),
    ResultOk(Box<StdValue>),
    ResultErr { type_name: String, variant: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StdError {
    RequestSchemaMismatch,
    RequestDigestMismatch,
    GraphRevisionInvalid,
    InputDigestInvalid,
    ArgumentsMismatch,
    ArgumentTypeMismatch,
    InvalidInteger,
    InvalidUtf8,
    UnknownOperation,
    HostAuthorityMismatch,
    HostRequestSchemaMismatch,
    PathOutsideSandbox,
    FileNotFound,
    FileAlreadyExists,
    SecretNotFound,
    SecretClosed,
    EnvironmentNotFound,
    OutputLimitExceeded,
    ResourceLimitExceeded,
    ValueInvalid,
    HostFault,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeStdRequest {
    pub schema: String,
    pub graph_revision: String,
    pub operation: StdOperation,
    pub arguments: BTreeMap<String, StdValue>,
    pub input_digest: String,
    pub request_digest: String,
}

impl NativeStdRequest {
    pub fn new(
        graph_revision: impl Into<String>,
        operation: StdOperation,
        arguments: BTreeMap<String, StdValue>,
        input_digest: impl Into<String>,
    ) -> Self {
        let mut request = Self {
            schema: MINIMAL_STD_REQUEST_SCHEMA.to_owned(),
            graph_revision: graph_revision.into(),
            operation,
            arguments,
            input_digest: input_digest.into(),
            request_digest: String::new(),
        };
        request.request_digest = request_digest(&request);
        request
    }
}

pub fn execute_minimal_std(request: &NativeStdRequest) -> Result<StdValue, StdError> {
    if request.schema != MINIMAL_STD_REQUEST_SCHEMA {
        return Err(StdError::RequestSchemaMismatch);
    }
    if !valid_digest(&request.graph_revision) {
        return Err(StdError::GraphRevisionInvalid);
    }
    if !valid_digest(&request.input_digest) {
        return Err(StdError::InputDigestInvalid);
    }
    if request.request_digest != request_digest(request) {
        return Err(StdError::RequestDigestMismatch);
    }
    validate_value_map(&request.arguments, 0)?;
    validate_arguments(request.operation, &request.arguments)?;
    execute(request.operation, &request.arguments)
}

pub fn request_digest(request: &NativeStdRequest) -> String {
    format!(
        "sha256:{}",
        sha256_hex(
            format!(
                "{{\"arguments\":{},\"graph_revision\":{},\"input_digest\":{},\"operation\":{},\"schema\":{}}}",
                serialize_arguments(&request.arguments),
                quote(&request.graph_revision),
                quote(&request.input_digest),
                quote(request.operation.name()),
                quote(&request.schema),
            )
            .as_bytes(),
        )
    )
}

fn validate_arguments(
    operation: StdOperation,
    arguments: &BTreeMap<String, StdValue>,
) -> Result<(), StdError> {
    let expected = operation.argument_names();
    if arguments.len() != expected.len()
        || expected.iter().any(|name| !arguments.contains_key(*name))
    {
        return Err(StdError::ArgumentsMismatch);
    }
    Ok(())
}

fn execute(
    operation: StdOperation,
    arguments: &BTreeMap<String, StdValue>,
) -> Result<StdValue, StdError> {
    let value = |name: &str| arguments.get(name).ok_or(StdError::ArgumentsMismatch);
    match operation {
        StdOperation::BytesByteCount => {
            let value = bytes(value("value")?)?;
            Ok(StdValue::Int(value.len().to_string()))
        }
        StdOperation::BytesConcat => {
            let left = bytes(value("left")?)?;
            let right = bytes(value("right")?)?;
            let output_len = left
                .len()
                .checked_add(right.len())
                .ok_or(StdError::ResourceLimitExceeded)?;
            if output_len > MAX_OUTPUT_BYTES {
                return Err(StdError::ResourceLimitExceeded);
            }
            let mut output = left;
            output.extend(right);
            Ok(StdValue::Bytes(output))
        }
        StdOperation::BytesDecodeUtf8 => match String::from_utf8(bytes(value("value")?)?) {
            Ok(text) => Ok(StdValue::ResultOk(Box::new(StdValue::Text(text)))),
            Err(_) => Ok(StdValue::ResultErr {
                type_name: "std.bytes.decode_error".to_owned(),
                variant: "invalid_utf8".to_owned(),
            }),
        },
        StdOperation::ListAppend => {
            let item = value("value")?.clone();
            let mut values = list(value("values")?)?;
            if values.len() == MAX_COLLECTION_ITEMS {
                return Err(StdError::ResourceLimitExceeded);
            }
            values.push(item);
            Ok(StdValue::List(values))
        }
        StdOperation::ListConcat => {
            let mut left = list(value("left")?)?;
            let right = list(value("right")?)?;
            let output_len = left
                .len()
                .checked_add(right.len())
                .ok_or(StdError::ResourceLimitExceeded)?;
            if output_len > MAX_COLLECTION_ITEMS {
                return Err(StdError::ResourceLimitExceeded);
            }
            left.extend(right);
            Ok(StdValue::List(left))
        }
        StdOperation::ListLength => {
            let values = list(value("values")?)?;
            Ok(StdValue::Int(values.len().to_string()))
        }
        StdOperation::ResultIsErr => Ok(StdValue::Bool(matches!(
            value("value")?,
            StdValue::ResultErr { .. }
        ))),
        StdOperation::ResultIsOk => Ok(StdValue::Bool(matches!(
            value("value")?,
            StdValue::ResultOk(_)
        ))),
        StdOperation::TextConcat => {
            let left = text(value("left")?)?;
            let right = text(value("right")?)?;
            let output_len = left
                .len()
                .checked_add(right.len())
                .ok_or(StdError::ResourceLimitExceeded)?;
            if output_len > MAX_OUTPUT_BYTES {
                return Err(StdError::ResourceLimitExceeded);
            }
            Ok(StdValue::Text(format!("{left}{right}")))
        }
        StdOperation::TextEncodeUtf8 => {
            Ok(StdValue::Bytes(text(value("value")?)?.as_bytes().to_vec()))
        }
        StdOperation::TextScalarCount => Ok(StdValue::Int(
            text(value("value")?)?.chars().count().to_string(),
        )),
    }
}

fn bytes(value: &StdValue) -> Result<Vec<u8>, StdError> {
    match value {
        StdValue::Bytes(value) => Ok(value.clone()),
        _ => Err(StdError::ArgumentTypeMismatch),
    }
}

fn list(value: &StdValue) -> Result<Vec<StdValue>, StdError> {
    match value {
        StdValue::List(value) => Ok(value.clone()),
        _ => Err(StdError::ArgumentTypeMismatch),
    }
}

fn text(value: &StdValue) -> Result<String, StdError> {
    match value {
        StdValue::Text(value) => Ok(value.clone()),
        _ => Err(StdError::ArgumentTypeMismatch),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostAuthority {
    pub schema: String,
    pub profile: String,
}

impl Default for HostAuthority {
    fn default() -> Self {
        Self {
            schema: HOST_REQUEST_SCHEMA.to_owned(),
            profile: HOST_PROFILE.to_owned(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HostOperation {
    ProcessArgs,
    StdoutWrite,
    FileRead,
    FileWrite,
    EnvironmentRead,
    SecretRead,
    ClockMonotonic,
    RandomBytes,
    LogEvent,
    TraceEvent,
    Unknown(String),
}

impl HostOperation {
    fn name(&self) -> &str {
        match self {
            Self::ProcessArgs => "process.args.read",
            Self::StdoutWrite => "process.stdout.write",
            Self::FileRead => "fs.read.read_file",
            Self::FileWrite => "fs.write.write_file",
            Self::EnvironmentRead => "config.read.read",
            Self::SecretRead => "secret.read.read",
            Self::ClockMonotonic => "clock.monotonic.now",
            Self::RandomBytes => "random.bytes.read",
            Self::LogEvent => "log.event.write",
            Self::TraceEvent => "trace.event.write",
            Self::Unknown(name) => name,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostRequest {
    pub schema: String,
    pub authority: HostAuthority,
    pub operation: HostOperation,
    pub argument: String,
    pub payload: Vec<u8>,
}

impl HostRequest {
    pub fn process_args() -> Self {
        Self::new(HostOperation::ProcessArgs, "")
    }

    pub fn stdout(text: impl Into<String>) -> Self {
        Self::new(HostOperation::StdoutWrite, text)
    }

    pub fn file_read(path: impl Into<String>) -> Self {
        Self::new(HostOperation::FileRead, path)
    }

    pub fn file_write(path: impl Into<String>, payload: Vec<u8>) -> Self {
        let mut request = Self::new(HostOperation::FileWrite, path);
        request.payload = payload;
        request
    }

    pub fn environment(name: impl Into<String>) -> Self {
        Self::new(HostOperation::EnvironmentRead, name)
    }

    pub fn secret(name: impl Into<String>) -> Self {
        Self::new(HostOperation::SecretRead, name)
    }

    pub fn clock() -> Self {
        Self::new(HostOperation::ClockMonotonic, "")
    }

    pub fn random(length: usize) -> Self {
        Self::new(HostOperation::RandomBytes, length.to_string())
    }

    pub fn log(message: impl Into<String>) -> Self {
        Self::new(HostOperation::LogEvent, message)
    }

    pub fn trace(message: impl Into<String>) -> Self {
        Self::new(HostOperation::TraceEvent, message)
    }

    pub fn unknown(name: impl Into<String>) -> Self {
        Self::new(HostOperation::Unknown(name.into()), "")
    }

    fn new(argument: HostOperation, value: impl Into<String>) -> Self {
        Self {
            schema: HOST_REQUEST_SCHEMA.to_owned(),
            authority: HostAuthority::default(),
            operation: argument,
            argument: value.into(),
            payload: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HostOutcome {
    Args(Vec<String>),
    Text(String),
    Bytes(Vec<u8>),
    Int(String),
    Unit,
}

pub trait HostAdapter {
    fn invoke(&mut self, request: &HostRequest) -> Result<HostOutcome, StdError>;
    fn close_secrets(&mut self);
}

pub struct HostEnvironment<A> {
    adapter: A,
}

impl<A: HostAdapter> HostEnvironment<A> {
    pub fn new(adapter: A) -> Self {
        Self { adapter }
    }

    pub fn into_inner(self) -> A {
        self.adapter
    }

    pub fn invoke(&mut self, request: HostRequest) -> Result<HostOutcome, StdError> {
        if request.schema != HOST_REQUEST_SCHEMA
            || request.authority.schema != HOST_REQUEST_SCHEMA
            || request.authority.profile != HOST_PROFILE
        {
            return Err(StdError::HostAuthorityMismatch);
        }
        let lock = HOST_PANIC_HOOK_LOCK.get_or_init(|| Mutex::new(()));
        let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let previous_hook = panic::take_hook();
        panic::set_hook(Box::new(|_| {}));
        let result = catch_unwind(AssertUnwindSafe(|| self.adapter.invoke(&request)))
            .unwrap_or(Err(StdError::HostFault));
        panic::set_hook(previous_hook);
        result
    }

    pub fn close_secrets(&mut self) {
        self.adapter.close_secrets();
    }
}

#[derive(Clone, Debug)]
pub struct MemoryHost {
    args: Vec<String>,
    environment: BTreeMap<String, String>,
    secrets: BTreeMap<String, Vec<u8>>,
    files: BTreeMap<String, Vec<u8>>,
    stdout: Vec<u8>,
    logs: Vec<String>,
    clock: u64,
    secret_closed: bool,
}

impl MemoryHost {
    pub fn new(
        args: Vec<String>,
        environment: BTreeMap<String, String>,
        secrets: BTreeMap<String, Vec<u8>>,
    ) -> Self {
        Self {
            args,
            environment,
            secrets,
            files: BTreeMap::new(),
            stdout: Vec::new(),
            logs: Vec::new(),
            clock: 0,
            secret_closed: false,
        }
    }

    pub fn seed_files(&mut self, files: BTreeMap<String, Vec<u8>>) {
        self.files = files;
    }

    pub fn stdout_bytes(&self) -> Vec<u8> {
        self.stdout.clone()
    }
}

impl HostAdapter for MemoryHost {
    fn invoke(&mut self, request: &HostRequest) -> Result<HostOutcome, StdError> {
        match &request.operation {
            HostOperation::ProcessArgs => Ok(HostOutcome::Args(self.args.clone())),
            HostOperation::StdoutWrite => {
                if request.argument.len() > 1_048_576usize.saturating_sub(self.stdout.len()) {
                    return Err(StdError::OutputLimitExceeded);
                }
                self.stdout.extend_from_slice(request.argument.as_bytes());
                Ok(HostOutcome::Unit)
            }
            HostOperation::FileRead => {
                validate_path(&request.argument)?;
                let bytes = self
                    .files
                    .get(&request.argument)
                    .cloned()
                    .ok_or(StdError::FileNotFound)?;
                String::from_utf8(bytes)
                    .map(HostOutcome::Text)
                    .map_err(|_| StdError::InvalidUtf8)
            }
            HostOperation::FileWrite => {
                validate_path(&request.argument)?;
                if request.payload.len() > 1_048_576 {
                    return Err(StdError::ResourceLimitExceeded);
                }
                self.files
                    .insert(request.argument.clone(), request.payload.clone());
                Ok(HostOutcome::Unit)
            }
            HostOperation::EnvironmentRead => self
                .environment
                .get(&request.argument)
                .cloned()
                .map(HostOutcome::Text)
                .ok_or(StdError::EnvironmentNotFound),
            HostOperation::SecretRead => {
                if self.secret_closed {
                    return Err(StdError::SecretClosed);
                }
                self.secrets
                    .get(&request.argument)
                    .cloned()
                    .map(HostOutcome::Bytes)
                    .ok_or(StdError::SecretNotFound)
            }
            HostOperation::ClockMonotonic => {
                self.clock = self.clock.saturating_add(1);
                Ok(HostOutcome::Int(self.clock.to_string()))
            }
            HostOperation::RandomBytes => {
                let length = request
                    .argument
                    .parse::<usize>()
                    .map_err(|_| StdError::ArgumentTypeMismatch)?;
                if length > 4096 {
                    return Err(StdError::ResourceLimitExceeded);
                }
                Ok(HostOutcome::Bytes(vec![0; length]))
            }
            HostOperation::LogEvent | HostOperation::TraceEvent => {
                if request.argument.len() > 65_536 {
                    return Err(StdError::OutputLimitExceeded);
                }
                self.logs
                    .push(format!("{}:{}", request.operation.name(), request.argument));
                Ok(HostOutcome::Unit)
            }
            HostOperation::Unknown(_) => Err(StdError::UnknownOperation),
        }
    }

    fn close_secrets(&mut self) {
        for value in self.secrets.values_mut() {
            value.fill(0);
        }
        self.secrets.clear();
        self.secret_closed = true;
    }
}

pub struct SystemHost {
    root: PathBuf,
    args: Vec<String>,
    environment: BTreeMap<String, String>,
    secrets: BTreeMap<String, Vec<u8>>,
    stdout: Box<dyn Write>,
    random: Box<dyn Read>,
    started: Instant,
    secret_closed: bool,
}

impl SystemHost {
    pub fn new(
        root: impl Into<PathBuf>,
        args: Vec<String>,
        environment: BTreeMap<String, String>,
        secrets: BTreeMap<String, Vec<u8>>,
        stdout: Box<dyn Write>,
        random_source: impl AsRef<Path>,
    ) -> Result<Self, StdError> {
        let root = root.into();
        let root = fs::canonicalize(root).map_err(|_| StdError::HostFault)?;
        let random = Box::new(File::open(random_source).map_err(|_| StdError::HostFault)?);
        Self::new_with_random_reader(root, args, environment, secrets, stdout, random)
    }

    pub fn new_with_random_reader(
        root: impl Into<PathBuf>,
        args: Vec<String>,
        environment: BTreeMap<String, String>,
        secrets: BTreeMap<String, Vec<u8>>,
        stdout: Box<dyn Write>,
        random: Box<dyn Read>,
    ) -> Result<Self, StdError> {
        let root = root.into();
        let root = fs::canonicalize(root).map_err(|_| StdError::HostFault)?;
        Ok(Self {
            root,
            args,
            environment,
            secrets,
            stdout,
            random,
            started: Instant::now(),
            secret_closed: false,
        })
    }

    fn path(&self, relative: &str, write: bool) -> Result<PathBuf, StdError> {
        validate_path(relative)?;
        let candidate = self.root.join(relative);
        let checked = if write {
            let parent = candidate.parent().ok_or(StdError::PathOutsideSandbox)?;
            fs::canonicalize(parent)
                .map_err(|error| map_io(error, true))?
                .join(candidate.file_name().ok_or(StdError::PathOutsideSandbox)?)
        } else {
            fs::canonicalize(&candidate).map_err(|error| map_io(error, false))?
        };
        if write {
            match fs::symlink_metadata(&candidate) {
                Ok(metadata) if metadata.file_type().is_symlink() => {
                    return Err(StdError::PathOutsideSandbox);
                }
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(map_io(error, true)),
            }
        }
        if !checked.starts_with(&self.root) {
            return Err(StdError::PathOutsideSandbox);
        }
        Ok(checked)
    }
}

impl HostAdapter for SystemHost {
    fn invoke(&mut self, request: &HostRequest) -> Result<HostOutcome, StdError> {
        match &request.operation {
            HostOperation::ProcessArgs => Ok(HostOutcome::Args(self.args.clone())),
            HostOperation::StdoutWrite => {
                if request.argument.len() > MAX_OUTPUT_BYTES {
                    return Err(StdError::OutputLimitExceeded);
                }
                self.stdout
                    .write_all(request.argument.as_bytes())
                    .map_err(|_| StdError::HostFault)?;
                self.stdout.flush().map_err(|_| StdError::HostFault)?;
                Ok(HostOutcome::Unit)
            }
            HostOperation::FileRead => {
                let path = self.path(&request.argument, false)?;
                let metadata = fs::metadata(&path).map_err(|error| map_io(error, false))?;
                if metadata.len() > MAX_OUTPUT_BYTES as u64 {
                    return Err(StdError::ResourceLimitExceeded);
                }
                let bytes = fs::read(path).map_err(|error| map_io(error, false))?;
                String::from_utf8(bytes)
                    .map(HostOutcome::Text)
                    .map_err(|_| StdError::InvalidUtf8)
            }
            HostOperation::FileWrite => {
                let path = self.path(&request.argument, true)?;
                if request.payload.len() > MAX_OUTPUT_BYTES {
                    return Err(StdError::ResourceLimitExceeded);
                }
                atomic_write(&path, &request.payload).map(|_| HostOutcome::Unit)
            }
            HostOperation::EnvironmentRead => self
                .environment
                .get(&request.argument)
                .cloned()
                .map(HostOutcome::Text)
                .ok_or(StdError::EnvironmentNotFound),
            HostOperation::SecretRead => {
                if self.secret_closed {
                    return Err(StdError::SecretClosed);
                }
                self.secrets
                    .get(&request.argument)
                    .cloned()
                    .map(HostOutcome::Bytes)
                    .ok_or(StdError::SecretNotFound)
            }
            HostOperation::ClockMonotonic => Ok(HostOutcome::Int(
                self.started.elapsed().as_nanos().to_string(),
            )),
            HostOperation::RandomBytes => {
                let length = request
                    .argument
                    .parse::<usize>()
                    .map_err(|_| StdError::ArgumentTypeMismatch)?;
                if length > MAX_RANDOM_BYTES {
                    return Err(StdError::ResourceLimitExceeded);
                }
                let mut bytes = vec![0; length];
                self.random
                    .read_exact(&mut bytes)
                    .map_err(|_| StdError::HostFault)?;
                Ok(HostOutcome::Bytes(bytes))
            }
            HostOperation::LogEvent | HostOperation::TraceEvent => {
                if request.argument.len() > 65_536 {
                    return Err(StdError::OutputLimitExceeded);
                }
                eprintln!("{}:{}", request.operation.name(), request.argument);
                Ok(HostOutcome::Unit)
            }
            HostOperation::Unknown(_) => Err(StdError::UnknownOperation),
        }
    }

    fn close_secrets(&mut self) {
        for value in self.secrets.values_mut() {
            value.fill(0);
        }
        self.secrets.clear();
        self.secret_closed = true;
    }
}

pub struct MinimalStdBridge {
    graph_revision: String,
    input_digest: String,
}

pub struct HostBackedBridge<A: HostAdapter> {
    capabilities_by_revision: BTreeMap<String, BTreeMap<String, String>>,
    active_capabilities: RefCell<Option<BTreeMap<String, String>>>,
    input_digest: String,
    observations: Vec<HostObservation>,
    host: HostEnvironment<A>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostObservation {
    pub sequence: u64,
    pub instance: String,
    pub member: String,
    pub invocation_id: String,
    pub operation: String,
    pub argument_digest: String,
    pub payload_digest: String,
    pub outcome: String,
    pub error: Option<String>,
    pub effect_committed: bool,
}

impl<A: HostAdapter> HostBackedBridge<A> {
    pub fn new(
        graph: &crate::graph::Graph,
        host: A,
        graph_revision: impl Into<String>,
        input_digest: impl Into<String>,
    ) -> Result<Self, String> {
        Self::new_for_graphs(
            std::slice::from_ref(&graph),
            host,
            graph_revision,
            input_digest,
        )
    }

    pub fn new_for_graphs(
        graphs: &[&crate::graph::Graph],
        host: A,
        graph_revision: impl Into<String>,
        input_digest: impl Into<String>,
    ) -> Result<Self, String> {
        let graph_revision = graph_revision.into();
        let input_digest = input_digest.into();
        if graphs.is_empty() || !valid_digest(&graph_revision) || !valid_digest(&input_digest) {
            return Err("native-host-bridge-authority-invalid".to_owned());
        }
        let mut capabilities_by_revision = BTreeMap::new();
        for graph in graphs {
            let expected_revision = crate::graph::graph_revision(graph)
                .map_err(|_| "native-host-bridge-graph-invalid")?;
            let mut capabilities = BTreeMap::new();
            for capability in &graph.capabilities {
                match capabilities.get(&capability.instance) {
                    Some(reference) if reference != &capability.reference => {
                        return Err("native-host-bridge-capability-conflict".to_owned());
                    }
                    Some(_) => {}
                    None => {
                        capabilities
                            .insert(capability.instance.clone(), capability.reference.clone());
                    }
                }
            }
            match capabilities_by_revision.get(&expected_revision) {
                Some(existing) if existing != &capabilities => {
                    return Err("native-host-bridge-capability-conflict".to_owned());
                }
                Some(_) => {}
                None => {
                    capabilities_by_revision.insert(expected_revision, capabilities);
                }
            }
        }
        if !capabilities_by_revision.contains_key(&graph_revision) {
            return Err("native-host-bridge-graph-mismatch".to_owned());
        }
        let active_capabilities = capabilities_by_revision
            .get(&graph_revision)
            .cloned()
            .ok_or_else(|| "native-host-bridge-graph-mismatch".to_owned())?;
        Ok(Self {
            capabilities_by_revision,
            active_capabilities: RefCell::new(Some(active_capabilities)),
            input_digest,
            observations: Vec::new(),
            host: HostEnvironment::new(host),
        })
    }

    pub fn into_host(self) -> A {
        self.host.into_inner()
    }

    pub fn observations(&self) -> &[HostObservation] {
        &self.observations
    }

    fn record_observation(
        &mut self,
        instance: &str,
        member: &str,
        request: &HostRequest,
        invocation_id: &str,
        outcome: &Result<HostOutcome, StdError>,
    ) {
        let (outcome_name, error) = match outcome {
            Ok(value) => (host_outcome_name(value).to_owned(), None),
            Err(error) => ("error".to_owned(), Some(host_error_name(error).to_owned())),
        };
        self.observations.push(HostObservation {
            sequence: self.observations.len() as u64,
            instance: instance.to_owned(),
            member: member.to_owned(),
            invocation_id: invocation_id.to_owned(),
            operation: request.operation.name().to_owned(),
            argument_digest: format!("sha256:{}", sha256_hex(request.argument.as_bytes())),
            payload_digest: format!("sha256:{}", sha256_hex(&request.payload)),
            outcome: outcome_name,
            error,
            effect_committed: outcome.is_ok()
                && matches!(
                    request.operation,
                    HostOperation::StdoutWrite | HostOperation::FileWrite
                ),
        });
    }

    fn record_rejected_observation(
        &mut self,
        instance: &str,
        member: &str,
        reference: &str,
        arguments: &BTreeMap<String, VmValue>,
        invocation_id: &str,
        error: &str,
    ) {
        let argument_source = arguments
            .iter()
            .map(|(name, value)| format!("{name}={}", serialize_vm_value(value)))
            .collect::<Vec<_>>()
            .join("|");
        self.observations.push(HostObservation {
            sequence: self.observations.len() as u64,
            instance: instance.to_owned(),
            member: member.to_owned(),
            invocation_id: invocation_id.to_owned(),
            operation: host_operation_name(reference, member).to_owned(),
            argument_digest: format!("sha256:{}", sha256_hex(argument_source.as_bytes())),
            payload_digest: format!("sha256:{}", sha256_hex(&[])),
            outcome: "error".to_owned(),
            error: Some(error.to_owned()),
            effect_committed: false,
        });
    }

    fn host_request(
        &self,
        instance: &str,
        reference: &str,
        member: &str,
        arguments: &BTreeMap<String, VmValue>,
    ) -> Result<HostRequest, String> {
        let exact_arguments = |expected: &[&str]| {
            arguments.len() == expected.len()
                && expected.iter().all(|name| arguments.contains_key(*name))
        };
        let text_argument = |name: &str| match arguments.get(name) {
            Some(VmValue::Text(value)) => Ok(value.clone()),
            Some(_) => Err("native-host-bridge-argument-type-mismatch".to_owned()),
            None => Err("native-host-bridge-argument-missing".to_owned()),
        };
        match (reference, member) {
            ("process.args@0.1.0", "read") if exact_arguments(&[]) => {
                Ok(HostRequest::process_args())
            }
            ("process.stdout@0.1.0", "write") if exact_arguments(&["data"]) => {
                Ok(HostRequest::stdout(text_argument("data")?))
            }
            ("fs.read@0.1.0", "read_file")
                if exact_arguments(&["path"]) || exact_arguments(&["encoding", "path"]) =>
            {
                if let Some(encoding) = arguments.get("encoding")
                    && encoding != &VmValue::Text("text.encoding.utf8".to_owned())
                {
                    return Err("native-host-bridge-encoding-unsupported".to_owned());
                }
                Ok(HostRequest::file_read(text_argument("path")?))
            }
            ("fs.write@0.1.0", "write_file") if exact_arguments(&["data", "path"]) => {
                let path = text_argument("path")?;
                let payload = match arguments.get("data") {
                    Some(VmValue::Bytes(value)) => value.clone(),
                    Some(_) => {
                        return Err("native-host-bridge-argument-type-mismatch".to_owned());
                    }
                    None => return Err("native-host-bridge-argument-missing".to_owned()),
                };
                Ok(HostRequest::file_write(path, payload))
            }
            _ => Err(format!(
                "native-host-bridge-operation-unsupported:{instance}.{member}"
            )),
        }
    }

    fn response(
        reference: &str,
        member: &str,
        outcome: Result<HostOutcome, StdError>,
    ) -> Result<CapabilityResponse, String> {
        match outcome {
            Ok(HostOutcome::Args(values))
                if reference == "process.args@0.1.0" && member == "read" =>
            {
                Ok(CapabilityResponse::ok(VmValue::List(
                    values.into_iter().map(VmValue::Text).collect(),
                )))
            }
            Ok(HostOutcome::Text(value))
                if reference == "fs.read@0.1.0" && member == "read_file" =>
            {
                Ok(CapabilityResponse::ok(VmValue::Text(value)))
            }
            Ok(HostOutcome::Unit)
                if (reference == "process.stdout@0.1.0" && member == "write")
                    || (reference == "fs.write@0.1.0" && member == "write_file") =>
            {
                Ok(CapabilityResponse::ok(VmValue::Unit))
            }
            Ok(_) => Ok(CapabilityResponse::host_fault(
                "native-host-return-type-mismatch",
            )),
            Err(StdError::HostFault) => {
                Ok(CapabilityResponse::host_fault("native-host-host-fault"))
            }
            Err(error) => {
                let (type_name, variant) = declared_host_error(reference, error)?;
                Ok(CapabilityResponse::err(VmValue::ResultErr {
                    type_name,
                    variant,
                }))
            }
        }
    }
}

impl<A: HostAdapter> CapabilityBridge for HostBackedBridge<A> {
    fn verify_authority(&self, graph_revision: &str, input_digest: &str) -> Result<(), String> {
        *self.active_capabilities.borrow_mut() = None;
        if self.input_digest != input_digest {
            return Err("native-host-bridge-authority-mismatch".to_owned());
        }
        let capabilities = self
            .capabilities_by_revision
            .get(graph_revision)
            .cloned()
            .ok_or_else(|| "native-host-bridge-authority-mismatch".to_owned())?;
        *self.active_capabilities.borrow_mut() = Some(capabilities);
        Ok(())
    }

    fn invoke(
        &mut self,
        instance: &str,
        member: &str,
        arguments: &BTreeMap<String, VmValue>,
        invocation_id: &str,
    ) -> Result<CapabilityResponse, String> {
        let capabilities = self
            .active_capabilities
            .borrow()
            .as_ref()
            .ok_or_else(|| "native-host-bridge-authority-mismatch".to_owned())?
            .clone();
        let reference = capabilities
            .get(instance)
            .ok_or_else(|| "native-host-bridge-capability-unknown".to_owned())?
            .clone();
        let request = match self.host_request(instance, &reference, member, arguments) {
            Ok(request) => request,
            Err(error) => {
                self.record_rejected_observation(
                    instance,
                    member,
                    &reference,
                    arguments,
                    invocation_id,
                    &error,
                );
                return Err(error);
            }
        };
        let outcome = self.host.invoke(request.clone());
        self.record_observation(instance, member, &request, invocation_id, &outcome);
        Self::response(&reference, member, outcome)
    }

    fn invoke_with_input(
        &mut self,
        instance: &str,
        member: &str,
        arguments: &BTreeMap<String, VmValue>,
        invocation_id: &str,
        _input: Option<&VmValue>,
    ) -> Result<CapabilityResponse, String> {
        self.invoke(instance, member, arguments, invocation_id)
    }
}

fn declared_host_error(reference: &str, error: StdError) -> Result<(String, String), String> {
    let (type_name, variant) = match reference {
        "process.args@0.1.0" => ("process.args_error", "invalid_utf8"),
        "fs.read@0.1.0" => (
            "fs.read_error",
            match error {
                StdError::PathOutsideSandbox => "outside_sandbox",
                StdError::FileNotFound => "not_found",
                StdError::InvalidUtf8 => "invalid_utf8",
                _ => "io",
            },
        ),
        "fs.write@0.1.0" => (
            "fs.write_error",
            match error {
                StdError::PathOutsideSandbox => "outside_sandbox",
                StdError::FileNotFound => "parent_not_found",
                _ => "io",
            },
        ),
        "process.stdout@0.1.0" => (
            "io.write_error",
            match error {
                StdError::OutputLimitExceeded => "io",
                _ => "io",
            },
        ),
        _ => return Err("native-host-bridge-error-reference-unknown".to_owned()),
    };
    Ok((type_name.to_owned(), variant.to_owned()))
}

impl MinimalStdBridge {
    pub fn new(
        graph_revision: impl Into<String>,
        input_digest: impl Into<String>,
    ) -> Result<Self, String> {
        let graph_revision = graph_revision.into();
        let input_digest = input_digest.into();
        if !valid_digest(&graph_revision) || !valid_digest(&input_digest) {
            return Err("minimal-std-bridge-authority-invalid".to_owned());
        }
        Ok(Self {
            graph_revision,
            input_digest,
        })
    }
}

impl CapabilityBridge for MinimalStdBridge {
    fn verify_authority(&self, graph_revision: &str, input_digest: &str) -> Result<(), String> {
        if self.graph_revision != graph_revision || self.input_digest != input_digest {
            return Err("minimal-std-bridge-authority-mismatch".to_owned());
        }
        Ok(())
    }

    fn invoke(
        &mut self,
        instance: &str,
        member: &str,
        arguments: &BTreeMap<String, VmValue>,
        _invocation_id: &str,
    ) -> Result<CapabilityResponse, String> {
        let operation = match (instance, member) {
            ("std.bytes", "byte_count") => StdOperation::BytesByteCount,
            ("std.bytes", "concat") => StdOperation::BytesConcat,
            ("std.bytes", "decode_utf8") => StdOperation::BytesDecodeUtf8,
            ("std.list", "append") => StdOperation::ListAppend,
            ("std.list", "concat") => StdOperation::ListConcat,
            ("std.list", "length") => StdOperation::ListLength,
            ("std.result", "is_err") => StdOperation::ResultIsErr,
            ("std.result", "is_ok") => StdOperation::ResultIsOk,
            ("std.text", "concat") => StdOperation::TextConcat,
            ("std.text", "encode_utf8") => StdOperation::TextEncodeUtf8,
            ("std.text", "scalar_count") => StdOperation::TextScalarCount,
            _ => return Err("minimal-std-bridge-operation-unknown".to_owned()),
        };
        let arguments = arguments
            .iter()
            .map(|(name, value)| Ok((name.clone(), std_value_from_vm(value)?)))
            .collect::<Result<BTreeMap<_, _>, String>>()?;
        let request = NativeStdRequest::new(
            self.graph_revision.clone(),
            operation,
            arguments,
            self.input_digest.clone(),
        );
        let value = execute_minimal_std(&request).map_err(|error| format!("{error:?}"))?;
        let value = vm_value_from_std(&value)?;
        Ok(CapabilityResponse::ok(value))
    }
}

fn validate_path(path: &str) -> Result<(), StdError> {
    if path.is_empty()
        || path.starts_with('/')
        || path == ".."
        || path.starts_with("../")
        || path.contains("/../")
        || path.ends_with("/..")
    {
        return Err(StdError::PathOutsideSandbox);
    }
    Ok(())
}

fn atomic_write(path: &Path, payload: &[u8]) -> Result<(), StdError> {
    let parent = path.parent().ok_or(StdError::PathOutsideSandbox)?;
    let temporary = parent.join(format!(
        ".revia-host-write-{}-{}",
        process::id(),
        HOST_WRITE_NONCE.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| map_io(error, true))?;
        file.write_all(payload).map_err(|_| StdError::HostFault)?;
        file.flush().map_err(|_| StdError::HostFault)?;
        file.sync_all().map_err(|_| StdError::HostFault)?;
        drop(file);
        fs::rename(&temporary, path).map_err(|error| map_io(error, true))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn host_outcome_name(outcome: &HostOutcome) -> &'static str {
    match outcome {
        HostOutcome::Args(_) => "args",
        HostOutcome::Text(_) => "text",
        HostOutcome::Bytes(_) => "bytes",
        HostOutcome::Int(_) => "int",
        HostOutcome::Unit => "unit",
    }
}

fn host_operation_name(reference: &str, member: &str) -> &'static str {
    match (reference, member) {
        ("process.args@0.1.0", "read") => "process.args.read",
        ("process.stdout@0.1.0", "write") => "process.stdout.write",
        ("fs.read@0.1.0", "read_file") => "fs.read.read_file",
        ("fs.write@0.1.0", "write_file") => "fs.write.write_file",
        _ => "unknown",
    }
}

fn host_error_name(error: &StdError) -> &'static str {
    match error {
        StdError::RequestSchemaMismatch => "request_schema_mismatch",
        StdError::RequestDigestMismatch => "request_digest_mismatch",
        StdError::GraphRevisionInvalid => "graph_revision_invalid",
        StdError::InputDigestInvalid => "input_digest_invalid",
        StdError::ArgumentsMismatch => "arguments_mismatch",
        StdError::ArgumentTypeMismatch => "argument_type_mismatch",
        StdError::InvalidInteger => "invalid_integer",
        StdError::InvalidUtf8 => "invalid_utf8",
        StdError::UnknownOperation => "unknown_operation",
        StdError::HostAuthorityMismatch => "host_authority_mismatch",
        StdError::HostRequestSchemaMismatch => "host_request_schema_mismatch",
        StdError::PathOutsideSandbox => "path_outside_sandbox",
        StdError::FileNotFound => "file_not_found",
        StdError::FileAlreadyExists => "file_already_exists",
        StdError::SecretNotFound => "secret_not_found",
        StdError::SecretClosed => "secret_closed",
        StdError::EnvironmentNotFound => "environment_not_found",
        StdError::OutputLimitExceeded => "output_limit_exceeded",
        StdError::ResourceLimitExceeded => "resource_limit_exceeded",
        StdError::ValueInvalid => "value_invalid",
        StdError::HostFault => "host_fault",
    }
}

fn map_io(error: io::Error, _write: bool) -> StdError {
    match error.kind() {
        io::ErrorKind::NotFound => StdError::FileNotFound,
        io::ErrorKind::PermissionDenied => StdError::HostFault,
        _ => StdError::HostFault,
    }
}

fn valid_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn serialize_arguments(arguments: &BTreeMap<String, StdValue>) -> String {
    let values = arguments
        .iter()
        .map(|(name, value)| format!("{}:{}", quote(name), serialize_value(value)))
        .collect::<Vec<_>>()
        .join(",");
    format!("{{{values}}}")
}

fn serialize_value(value: &StdValue) -> String {
    match value {
        StdValue::Unit => "{\"kind\":\"unit\"}".to_owned(),
        StdValue::Bool(value) => format!("{{\"kind\":\"bool\",\"value\":{value}}}"),
        StdValue::Int(value) => format!("{{\"kind\":\"int\",\"value\":{}}}", quote(value)),
        StdValue::Text(value) => format!("{{\"kind\":\"text\",\"value\":{}}}", quote(value)),
        StdValue::Bytes(value) => format!(
            "{{\"encoding\":\"hex\",\"kind\":\"bytes\",\"value\":\"{}\"}}",
            value
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        ),
        StdValue::List(values) => format!(
            "{{\"items\":[{}],\"kind\":\"list\"}}",
            values
                .iter()
                .map(serialize_value)
                .collect::<Vec<_>>()
                .join(",")
        ),
        StdValue::Record(fields) => format!(
            "{{\"fields\":{{{}}},\"kind\":\"record\"}}",
            fields
                .iter()
                .map(|(name, value)| format!("{}:{}", quote(name), serialize_value(value)))
                .collect::<Vec<_>>()
                .join(",")
        ),
        StdValue::ResultOk(value) => {
            format!("{{\"kind\":\"ok\",\"value\":{}}}", serialize_value(value))
        }
        StdValue::ResultErr { type_name, variant } => format!(
            "{{\"error\":{{\"type\":{},\"variant\":{}}},\"kind\":\"err\"}}",
            quote(type_name),
            quote(variant)
        ),
    }
}

fn validate_value_map(values: &BTreeMap<String, StdValue>, depth: usize) -> Result<(), StdError> {
    if values.len() > MAX_COLLECTION_ITEMS {
        return Err(StdError::ResourceLimitExceeded);
    }
    for value in values.values() {
        validate_value(value, depth)?;
    }
    Ok(())
}

fn validate_value(value: &StdValue, depth: usize) -> Result<(), StdError> {
    if depth > MAX_VALUE_DEPTH {
        return Err(StdError::ResourceLimitExceeded);
    }
    match value {
        StdValue::Int(value) => {
            if !canonical_int(value) {
                return Err(StdError::ValueInvalid);
            }
        }
        StdValue::Text(value) if value.len() > MAX_OUTPUT_BYTES => {
            return Err(StdError::ResourceLimitExceeded);
        }
        StdValue::Bytes(value) if value.len() > MAX_OUTPUT_BYTES => {
            return Err(StdError::ResourceLimitExceeded);
        }
        StdValue::Text(_) | StdValue::Bytes(_) | StdValue::Unit | StdValue::Bool(_) => {}
        StdValue::List(values) => {
            if values.len() > MAX_COLLECTION_ITEMS {
                return Err(StdError::ResourceLimitExceeded);
            }
            for value in values {
                validate_value(value, depth + 1)?;
            }
        }
        StdValue::Record(fields) => validate_value_map(fields, depth + 1)?,
        StdValue::ResultOk(value) => validate_value(value, depth + 1)?,
        StdValue::ResultErr { type_name, variant } => {
            if type_name.is_empty() || variant.is_empty() {
                return Err(StdError::ValueInvalid);
            }
        }
    }
    Ok(())
}

fn canonical_int(value: &str) -> bool {
    (value == "0" || !value.starts_with('0'))
        && !value.is_empty()
        && value.strip_prefix('-').unwrap_or(value).chars().count() > 0
        && value
            .strip_prefix('-')
            .unwrap_or(value)
            .chars()
            .all(|character| character.is_ascii_digit())
        && !value.starts_with("-0")
}

fn std_value_from_vm(value: &VmValue) -> Result<StdValue, String> {
    match value {
        VmValue::Unit => Ok(StdValue::Unit),
        VmValue::Bool(value) => Ok(StdValue::Bool(*value)),
        VmValue::Text(value) => Ok(StdValue::Text(value.clone())),
        VmValue::Bytes(value) => Ok(StdValue::Bytes(value.clone())),
        VmValue::Int(value) => Ok(StdValue::Int(value.to_string())),
        VmValue::ResultOk(value) => Ok(StdValue::ResultOk(Box::new(std_value_from_vm(value)?))),
        VmValue::ResultErr { type_name, variant } => Ok(StdValue::ResultErr {
            type_name: type_name.clone(),
            variant: variant.clone(),
        }),
        VmValue::List(values) => values
            .iter()
            .map(std_value_from_vm)
            .collect::<Result<Vec<_>, _>>()
            .map(StdValue::List),
        VmValue::Record(fields) => fields
            .iter()
            .map(|(name, value)| Ok((name.clone(), std_value_from_vm(value)?)))
            .collect::<Result<BTreeMap<_, _>, String>>()
            .map(StdValue::Record),
    }
}

fn vm_value_from_std(value: &StdValue) -> Result<VmValue, String> {
    match value {
        StdValue::Unit => Ok(VmValue::Unit),
        StdValue::Bool(value) => Ok(VmValue::Bool(*value)),
        StdValue::Int(value) => value
            .parse::<i64>()
            .map(VmValue::Int)
            .map_err(|_| "minimal-std-vm-integer-out-of-range".to_owned()),
        StdValue::Text(value) => Ok(VmValue::Text(value.clone())),
        StdValue::Bytes(value) => Ok(VmValue::Bytes(value.clone())),
        StdValue::List(values) => values
            .iter()
            .map(vm_value_from_std)
            .collect::<Result<Vec<_>, _>>()
            .map(VmValue::List),
        StdValue::Record(fields) => fields
            .iter()
            .map(|(name, value)| Ok((name.clone(), vm_value_from_std(value)?)))
            .collect::<Result<BTreeMap<_, _>, String>>()
            .map(VmValue::Record),
        StdValue::ResultOk(value) => Ok(VmValue::ResultOk(Box::new(vm_value_from_std(value)?))),
        StdValue::ResultErr { type_name, variant } => Ok(VmValue::ResultErr {
            type_name: type_name.clone(),
            variant: variant.clone(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vm_conversion_rejects_integer_values_that_do_not_fit_vm() {
        assert_eq!(
            vm_value_from_std(&StdValue::Int("9223372036854775808".to_owned())),
            Err("minimal-std-vm-integer-out-of-range".to_owned())
        );
    }
}
