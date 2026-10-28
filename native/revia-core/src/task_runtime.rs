use std::collections::{BTreeMap, BTreeSet};

use crate::{canonical_json::quote, digest::sha256_hex};

pub const NATIVE_TASK_REQUEST_SCHEMA: &str = "re.native-task-request@0.1.0";
pub const NATIVE_TASK_RESULT_SCHEMA: &str = "re.native-task-result@0.1.0";
pub const NATIVE_TASK_RECEIPT_SCHEMA: &str = "re.native-task-receipt@0.1.0";
pub const NATIVE_TASK_RUNTIME: &str = "re.native-task-runtime@0.1.0";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TaskValue {
    Null,
    Bool(bool),
    Number(String),
    String(String),
    Array(Vec<TaskValue>),
    Object(BTreeMap<String, TaskValue>),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskContract {
    pub schema: String,
    pub agent: String,
    pub module: String,
    pub node_uid: String,
    pub max_attempts: u8,
    pub backoff_ms: Vec<u64>,
    pub retryable_errors: Vec<String>,
    pub checkpoint_fields: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PerformerAuthority {
    pub executor: String,
    pub graph_revision: String,
    pub artifact_digest: String,
    pub profile: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskRequest {
    pub schema: String,
    pub agent: String,
    pub module: String,
    pub node_uid: String,
    pub revision: String,
    pub idempotency_key: String,
    pub input: TaskValue,
    pub input_digest: String,
    pub task_id: String,
    pub executor: String,
    pub graph_revision: String,
    pub artifact_digest: String,
    pub profile: String,
    pub request_digest: String,
}

impl TaskRequest {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        agent: impl Into<String>,
        module: impl Into<String>,
        node_uid: impl Into<String>,
        revision: impl Into<String>,
        idempotency_key: impl Into<String>,
        input: TaskValue,
        authority: PerformerAuthority,
    ) -> Self {
        let agent = agent.into();
        let module = module.into();
        let node_uid = node_uid.into();
        let revision = revision.into();
        let idempotency_key = idempotency_key.into();
        let input_digest = digest(&serialize_value(&input));
        let task_id = digest(&format!(
            "{{\"agent\":{},\"caller_idempotency_key\":{},\"input\":{},\"module\":{},\"node_uid\":{},\"revision\":{}}}",
            quote(&agent),
            quote(&idempotency_key),
            serialize_value(&input),
            quote(&module),
            quote(&node_uid),
            quote(&revision),
        ));
        let mut request = Self {
            schema: NATIVE_TASK_REQUEST_SCHEMA.to_owned(),
            agent,
            module,
            node_uid,
            revision,
            idempotency_key,
            input,
            input_digest,
            task_id,
            executor: authority.executor,
            graph_revision: authority.graph_revision,
            artifact_digest: authority.artifact_digest,
            profile: authority.profile,
            request_digest: String::new(),
        };
        request.request_digest = task_request_digest(&request);
        request
    }

    pub fn task_id(&self) -> String {
        self.task_id.clone()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskCheckpoint {
    pub attempt: u8,
    pub data: TaskValue,
    pub input_digest: String,
    pub revision: String,
    pub state: String,
    pub task_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskError {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskEffect {
    pub key: String,
    pub payload: TaskValue,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TaskPerformerOutcome {
    Success {
        effect: Option<TaskEffect>,
        output: TaskValue,
    },
    Error {
        checkpoint: TaskValue,
        error: TaskError,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TaskPerformerFault;

pub struct TaskPerformInput<'a> {
    pub attempt: u8,
    pub checkpoint: Option<&'a TaskCheckpoint>,
    pub input: &'a TaskValue,
    pub task_id: &'a str,
}

pub trait TaskPerformer {
    fn authority(&self) -> &PerformerAuthority;

    fn perform(
        &mut self,
        input: TaskPerformInput<'_>,
        lifecycle: &mut TaskLifecycleState,
    ) -> Result<TaskPerformerOutcome, TaskPerformerFault>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EffectRecord {
    pub attempt: u8,
    pub effect_key: String,
    pub output: TaskValue,
    pub payload: TaskValue,
    pub task_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CancelAt {
    BeforeStart,
    AfterStart,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CancelReason {
    BeforeStart,
    AfterStart,
    Parent,
    Timeout,
}

impl CancelReason {
    fn name(&self) -> &'static str {
        match self {
            Self::BeforeStart => "before_start",
            Self::AfterStart => "after_start",
            Self::Parent => "parent",
            Self::Timeout => "timeout",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SignalPlan {
    pub initially_aborted: bool,
    pub setup_fault: bool,
    pub cleanup_fault: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TimerPlan {
    pub setup_fault: bool,
    pub cleanup_fault: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LifecyclePlan {
    pub cancel_at: Option<CancelAt>,
    pub signal: Option<SignalPlan>,
    pub timer: Option<TimerPlan>,
    pub resource: bool,
    pub resource_close_fault: bool,
}

impl LifecyclePlan {
    pub fn resource() -> Self {
        Self {
            resource: true,
            ..Self::default()
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TaskLifecycleState {
    reason: Option<CancelReason>,
}

impl TaskLifecycleState {
    pub fn cancel(&mut self, reason: CancelReason) {
        if self.reason.is_none() {
            self.reason = Some(reason);
        }
    }

    pub fn reason(&self) -> Option<&CancelReason> {
        self.reason.as_ref()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskRuntimeLimits {
    pub max_effects: usize,
    pub max_trace_entries: usize,
}

impl Default for TaskRuntimeLimits {
    fn default() -> Self {
        Self {
            max_effects: 1_024,
            max_trace_entries: 256,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TaskTraceEntry {
    AttemptStart {
        attempt: u8,
        backoff_ms: u64,
    },
    AttemptError {
        attempt: u8,
        error: TaskError,
    },
    Retry {
        attempt: u8,
        checkpoint_digest: String,
    },
    Success {
        attempt: u8,
        effect_key: String,
    },
    Replay {
        task_id: String,
    },
    CancelBeforeStart {
        task_id: String,
    },
    CancelAfterStart {
        attempt: u8,
    },
    ResourceClose,
}

impl TaskTraceEntry {
    fn kind(&self) -> &'static str {
        match self {
            Self::AttemptStart { .. } => "attempt-start",
            Self::AttemptError { .. } => "attempt-error",
            Self::Retry { .. } => "retry",
            Self::Success { .. } => "success",
            Self::Replay { .. } => "replay",
            Self::CancelBeforeStart { .. } => "cancel-before-start",
            Self::CancelAfterStart { .. } => "cancel-after-start",
            Self::ResourceClose => "resource-close",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskDiagnostic {
    pub code: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskReceipt {
    pub schema: String,
    pub runtime: String,
    pub task_id: String,
    pub request_digest: String,
    pub attempts: u8,
    pub performer_calls: u8,
    pub replayed: bool,
    pub cancel_reason: Option<CancelReason>,
    pub cleanup_events: Vec<String>,
    pub effect_count: usize,
    pub effects_digest: String,
    pub output_digest: Option<String>,
    pub trace: Vec<TaskTraceEntry>,
    pub trace_digest: String,
    pub receipt_digest: String,
}

impl TaskReceipt {
    pub fn trace_kinds(&self) -> Vec<&'static str> {
        self.trace.iter().map(TaskTraceEntry::kind).collect()
    }

    pub fn attempt_backoffs(&self) -> Vec<u64> {
        self.trace
            .iter()
            .filter_map(|entry| match entry {
                TaskTraceEntry::AttemptStart { backoff_ms, .. } => Some(*backoff_ms),
                _ => None,
            })
            .collect()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskExecution {
    pub schema: String,
    pub terminal: String,
    pub error: Option<TaskDiagnostic>,
    pub output: Option<TaskValue>,
    pub receipt: TaskReceipt,
    pub result_digest: String,
}

impl TaskExecution {
    pub fn error_code(&self) -> Option<&str> {
        self.error.as_ref().map(|error| error.code.as_str())
    }
}

pub fn task_request_digest(request: &TaskRequest) -> String {
    digest(&format!(
        "{{\"agent\":{},\"artifact_digest\":{},\"executor\":{},\"graph_revision\":{},\"idempotency_key\":{},\"input\":{},\"input_digest\":{},\"module\":{},\"node_uid\":{},\"profile\":{},\"revision\":{},\"schema\":{},\"task_id\":{}}}",
        quote(&request.agent),
        quote(&request.artifact_digest),
        quote(&request.executor),
        quote(&request.graph_revision),
        quote(&request.idempotency_key),
        serialize_value(&request.input),
        quote(&request.input_digest),
        quote(&request.module),
        quote(&request.node_uid),
        quote(&request.profile),
        quote(&request.revision),
        quote(&request.schema),
        quote(&request.task_id),
    ))
}

#[allow(clippy::too_many_arguments)]
pub fn execute_task(
    contract: &TaskContract,
    request: &TaskRequest,
    checkpoint: Option<&TaskCheckpoint>,
    effects: &mut BTreeMap<String, EffectRecord>,
    performer: &mut dyn TaskPerformer,
    plan: LifecyclePlan,
    limits: TaskRuntimeLimits,
) -> TaskExecution {
    let mut runtime = Runtime::new(request, effects, plan, limits);
    let mut primary = validate_admission(
        contract,
        request,
        performer.authority(),
        &runtime.plan,
        &runtime.limits,
    )
    .err()
    .map(str::to_owned);

    if primary.is_none() {
        primary = runtime.start().err().map(str::to_owned);
    }

    let mut terminal = "rejected".to_owned();
    let mut output = None;
    let mut replayed = false;
    let mut attempts = 0;
    let mut newly_committed = None;

    if primary.is_none() {
        match run_task(contract, request, checkpoint, performer, &mut runtime) {
            Ok(run) => {
                terminal = run.terminal;
                output = run.output;
                replayed = run.replayed;
                attempts = run.attempts;
                newly_committed = run.newly_committed;
            }
            Err(error) => {
                primary = Some(error);
            }
        }
    }

    let cleanup_error = runtime.close();
    if primary.is_none() {
        primary = cleanup_error;
    }
    if primary.is_some() {
        if let Some(effect_key) = newly_committed {
            runtime.effects.remove(&effect_key);
        }
        terminal = "rejected".to_owned();
        output = None;
        replayed = false;
        attempts = runtime.performer_calls;
        runtime.trace.clear();
    } else if runtime.plan.resource
        && let Err(error) = runtime.push_trace(TaskTraceEntry::ResourceClose)
    {
        if let Some(effect_key) = newly_committed {
            runtime.effects.remove(&effect_key);
        }
        primary = Some(error);
        terminal = "rejected".to_owned();
        output = None;
        replayed = false;
        attempts = runtime.performer_calls;
        runtime.trace.clear();
    }

    build_execution(
        request, terminal, primary, output, attempts, replayed, runtime,
    )
}

struct Runtime<'a> {
    effects: &'a mut BTreeMap<String, EffectRecord>,
    plan: LifecyclePlan,
    limits: TaskRuntimeLimits,
    lifecycle: TaskLifecycleState,
    trace: Vec<TaskTraceEntry>,
    cleanup_events: Vec<String>,
    performer_calls: u8,
    signal_established: bool,
    timer_established: bool,
}

impl<'a> Runtime<'a> {
    fn new(
        _request: &'a TaskRequest,
        effects: &'a mut BTreeMap<String, EffectRecord>,
        plan: LifecyclePlan,
        limits: TaskRuntimeLimits,
    ) -> Self {
        Self {
            effects,
            plan,
            limits,
            lifecycle: TaskLifecycleState::default(),
            trace: Vec::new(),
            cleanup_events: Vec::new(),
            performer_calls: 0,
            signal_established: false,
            timer_established: false,
        }
    }

    fn start(&mut self) -> Result<(), &'static str> {
        if let Some(signal) = &self.plan.signal {
            self.signal_established = true;
            if signal.setup_fault {
                return Err("invalid-task-signal");
            }
            if signal.initially_aborted {
                self.lifecycle.cancel(CancelReason::Parent);
            }
        }
        if self.lifecycle.reason().is_none()
            && let Some(timer) = &self.plan.timer
        {
            if timer.setup_fault {
                return Err("invalid-task-timeout");
            }
            self.timer_established = true;
        }
        Ok(())
    }

    fn close(&mut self) -> Option<String> {
        let mut first = None;
        if self.timer_established {
            self.cleanup_events.push("timer-clear".to_owned());
            if self
                .plan
                .timer
                .as_ref()
                .is_some_and(|timer| timer.cleanup_fault)
            {
                first = Some("invalid-task-timeout".to_owned());
            }
        }
        if self.signal_established {
            self.cleanup_events.push("signal-remove".to_owned());
            if first.is_none()
                && self
                    .plan
                    .signal
                    .as_ref()
                    .is_some_and(|signal| signal.cleanup_fault)
            {
                first = Some("invalid-task-signal".to_owned());
            }
        }
        if self.plan.resource {
            self.cleanup_events.push("resource-close".to_owned());
            if first.is_none() && self.plan.resource_close_fault {
                first = Some("task-resource-close-failure".to_owned());
            }
        }
        first
    }

    fn push_trace(&mut self, entry: TaskTraceEntry) -> Result<(), String> {
        if self.trace.len() >= self.limits.max_trace_entries {
            return Err("native-task-trace-limit-exceeded".to_owned());
        }
        self.trace.push(entry);
        Ok(())
    }
}

struct RunResult {
    terminal: String,
    output: Option<TaskValue>,
    replayed: bool,
    attempts: u8,
    newly_committed: Option<String>,
}

fn run_task(
    contract: &TaskContract,
    request: &TaskRequest,
    checkpoint: Option<&TaskCheckpoint>,
    performer: &mut dyn TaskPerformer,
    runtime: &mut Runtime<'_>,
) -> Result<RunResult, String> {
    let mut current_checkpoint = validate_checkpoint(contract, request, checkpoint)?;

    if let Some(effect) = runtime
        .effects
        .values()
        .find(|effect| effect.task_id == request.task_id)
    {
        let attempt = effect.attempt;
        let output = effect.output.clone();
        runtime.push_trace(TaskTraceEntry::Replay {
            task_id: request.task_id.clone(),
        })?;
        return Ok(RunResult {
            terminal: "succeeded".to_owned(),
            output: Some(output),
            replayed: true,
            attempts: attempt,
            newly_committed: None,
        });
    }

    if runtime.lifecycle.reason().is_some() || runtime.plan.cancel_at == Some(CancelAt::BeforeStart)
    {
        if runtime.lifecycle.reason().is_none() {
            runtime.lifecycle.cancel(CancelReason::BeforeStart);
        }
        runtime.push_trace(TaskTraceEntry::CancelBeforeStart {
            task_id: request.task_id.clone(),
        })?;
        return Ok(RunResult {
            terminal: "cancelled".to_owned(),
            output: None,
            replayed: false,
            attempts: current_checkpoint
                .as_ref()
                .map_or(0, |checkpoint| checkpoint.attempt),
            newly_committed: None,
        });
    }

    let mut attempt = current_checkpoint
        .as_ref()
        .map_or(0, |checkpoint| checkpoint.attempt);
    while attempt < contract.max_attempts {
        attempt += 1;
        let backoff_ms = if attempt == 1 {
            0
        } else {
            contract.backoff_ms[usize::from(attempt - 2)]
        };
        runtime.push_trace(TaskTraceEntry::AttemptStart {
            attempt,
            backoff_ms,
        })?;
        runtime.performer_calls = runtime.performer_calls.saturating_add(1);
        let outcome = performer
            .perform(
                TaskPerformInput {
                    attempt,
                    checkpoint: current_checkpoint.as_ref(),
                    input: &request.input,
                    task_id: &request.task_id,
                },
                &mut runtime.lifecycle,
            )
            .map_err(|_| "task-runtime-failure".to_owned())?;

        let effect_missing = matches!(&outcome, TaskPerformerOutcome::Success { effect: None, .. });
        if runtime.lifecycle.reason().is_some()
            || (runtime.plan.cancel_at == Some(CancelAt::AfterStart) && effect_missing)
        {
            if runtime.lifecycle.reason().is_none() {
                runtime.lifecycle.cancel(CancelReason::AfterStart);
            }
            runtime.push_trace(TaskTraceEntry::CancelAfterStart { attempt })?;
            return Ok(RunResult {
                terminal: "cancelled".to_owned(),
                output: None,
                replayed: false,
                attempts: attempt,
                newly_committed: None,
            });
        }

        match outcome {
            TaskPerformerOutcome::Success { effect, output } => {
                let effect = effect.ok_or_else(|| "missing-task-effect".to_owned())?;
                if effect.key.is_empty() {
                    return Err("invalid-task-effect".to_owned());
                }
                validate_value(&output).map_err(str::to_owned)?;
                validate_value(&effect.payload).map_err(str::to_owned)?;
                runtime.push_trace(TaskTraceEntry::Success {
                    attempt,
                    effect_key: effect.key.clone(),
                })?;
                if let Some(existing) = runtime.effects.get(&effect.key) {
                    if existing.task_id != request.task_id {
                        return Err("duplicate-effect-key".to_owned());
                    }
                    return Ok(RunResult {
                        terminal: "succeeded".to_owned(),
                        output: Some(output),
                        replayed: true,
                        attempts: attempt,
                        newly_committed: None,
                    });
                }
                if runtime.effects.len() >= runtime.limits.max_effects {
                    return Err("native-task-effect-limit-exceeded".to_owned());
                }
                runtime.effects.insert(
                    effect.key.clone(),
                    EffectRecord {
                        attempt,
                        effect_key: effect.key.clone(),
                        output: output.clone(),
                        payload: effect.payload,
                        task_id: request.task_id.clone(),
                    },
                );
                return Ok(RunResult {
                    terminal: "succeeded".to_owned(),
                    output: Some(output),
                    replayed: false,
                    attempts: attempt,
                    newly_committed: Some(effect.key),
                });
            }
            TaskPerformerOutcome::Error { checkpoint, error } => {
                if error.code.is_empty() || error.message.is_empty() {
                    return Err("invalid-task-error".to_owned());
                }
                validate_value(&checkpoint).map_err(str::to_owned)?;
                runtime.push_trace(TaskTraceEntry::AttemptError {
                    attempt,
                    error: error.clone(),
                })?;
                if !contract.retryable_errors.contains(&error.code)
                    || attempt >= contract.max_attempts
                {
                    return Ok(RunResult {
                        terminal: "failed".to_owned(),
                        output: None,
                        replayed: false,
                        attempts: attempt,
                        newly_committed: None,
                    });
                }
                validate_checkpoint_data(contract, &checkpoint)?;
                let next = TaskCheckpoint {
                    attempt,
                    data: checkpoint,
                    input_digest: request.input_digest.clone(),
                    revision: request.revision.clone(),
                    state: "retrying".to_owned(),
                    task_id: request.task_id.clone(),
                };
                runtime.push_trace(TaskTraceEntry::Retry {
                    attempt,
                    checkpoint_digest: checkpoint_digest(&next),
                })?;
                current_checkpoint = Some(next);
            }
        }
    }
    Err("task-runtime-no-terminal-outcome".to_owned())
}

fn validate_admission(
    contract: &TaskContract,
    request: &TaskRequest,
    authority: &PerformerAuthority,
    plan: &LifecyclePlan,
    limits: &TaskRuntimeLimits,
) -> Result<(), &'static str> {
    validate_contract(contract)?;
    if request.schema != NATIVE_TASK_REQUEST_SCHEMA {
        return Err("native-task-request-schema-mismatch");
    }
    if request.agent != contract.agent
        || request.module != contract.module
        || request.node_uid != contract.node_uid
    {
        return Err("detached-task");
    }
    if request.revision.is_empty()
        || request.idempotency_key.is_empty()
        || request.idempotency_key.len() > 256
    {
        return Err("invalid-task-request");
    }
    validate_value(&request.input)?;
    if request.input_digest != digest(&serialize_value(&request.input)) {
        return Err("native-task-input-digest-mismatch");
    }
    let expected_task_id = TaskRequest::new(
        request.agent.clone(),
        request.module.clone(),
        request.node_uid.clone(),
        request.revision.clone(),
        request.idempotency_key.clone(),
        request.input.clone(),
        authority.clone(),
    )
    .task_id;
    if request.task_id != expected_task_id {
        return Err("native-task-id-mismatch");
    }
    if request.request_digest != task_request_digest(request) {
        return Err("native-task-request-digest-mismatch");
    }
    if request.executor != authority.executor
        || request.graph_revision != authority.graph_revision
        || request.artifact_digest != authority.artifact_digest
        || request.profile != authority.profile
    {
        return Err("native-task-performer-authority-mismatch");
    }
    if request.executor.is_empty()
        || request.profile.is_empty()
        || !valid_digest(&request.graph_revision)
        || !valid_digest(&request.artifact_digest)
    {
        return Err("native-task-performer-authority-invalid");
    }
    if limits.max_effects == 0 {
        return Err("native-task-effect-limit-invalid");
    }
    if limits.max_trace_entries == 0 {
        return Err("native-task-trace-limit-invalid");
    }
    if plan.resource_close_fault && !plan.resource {
        return Err("invalid-task-resource");
    }
    Ok(())
}

fn validate_contract(contract: &TaskContract) -> Result<(), &'static str> {
    if contract.schema != "re.task-contract@0.1.0" {
        return Err("unsupported-task-contract");
    }
    if !valid_semantic_name(&contract.agent)
        || !valid_semantic_name(&contract.module)
        || !valid_uid(&contract.node_uid)
    {
        return Err("invalid-task-contract");
    }
    if !(1..=32).contains(&contract.max_attempts)
        || contract.backoff_ms.len() != usize::from(contract.max_attempts - 1)
    {
        return Err("invalid-task-max-attempts");
    }
    let retryable = contract.retryable_errors.iter().collect::<BTreeSet<_>>();
    if retryable.len() != contract.retryable_errors.len()
        || contract
            .retryable_errors
            .iter()
            .any(|name| !valid_name(name))
    {
        return Err("invalid-task-retryable-error");
    }
    let fields = contract.checkpoint_fields.iter().collect::<BTreeSet<_>>();
    if fields.len() != contract.checkpoint_fields.len()
        || !fields.contains(&"revision".to_owned())
        || !fields.contains(&"input_digest".to_owned())
        || contract
            .checkpoint_fields
            .iter()
            .any(|name| !valid_name(name))
    {
        return Err("invalid-task-checkpoint-fields");
    }
    Ok(())
}

fn validate_checkpoint(
    contract: &TaskContract,
    request: &TaskRequest,
    checkpoint: Option<&TaskCheckpoint>,
) -> Result<Option<TaskCheckpoint>, String> {
    let Some(checkpoint) = checkpoint else {
        return Ok(None);
    };
    if checkpoint.attempt == 0
        || !matches!(checkpoint.state.as_str(), "running" | "retrying")
        || !valid_digest(&checkpoint.task_id)
        || !valid_digest(&checkpoint.input_digest)
    {
        return Err("invalid-task-checkpoint".to_owned());
    }
    if checkpoint.task_id != request.task_id
        || checkpoint.revision != request.revision
        || checkpoint.input_digest != request.input_digest
    {
        return Err("stale-task-checkpoint".to_owned());
    }
    if checkpoint.attempt > contract.max_attempts {
        return Err("task-checkpoint-attempt-limit".to_owned());
    }
    validate_checkpoint_data(contract, &checkpoint.data)?;
    Ok(Some(checkpoint.clone()))
}

fn validate_checkpoint_data(contract: &TaskContract, data: &TaskValue) -> Result<(), String> {
    let TaskValue::Object(values) = data else {
        return Err("invalid-task-retry-checkpoint-data".to_owned());
    };
    let expected = contract
        .checkpoint_fields
        .iter()
        .filter(|field| !matches!(field.as_str(), "revision" | "input_digest"))
        .collect::<BTreeSet<_>>();
    let actual = values.keys().collect::<BTreeSet<_>>();
    if actual != expected {
        return Err(if actual.iter().any(|field| !expected.contains(field)) {
            "unexpected-task-retry-checkpoint-data-field".to_owned()
        } else {
            "missing-task-retry-checkpoint-data-field".to_owned()
        });
    }
    Ok(())
}

fn checkpoint_digest(checkpoint: &TaskCheckpoint) -> String {
    digest(&format!(
        "{{\"attempt\":{},\"data\":{},\"input_digest\":{},\"revision\":{},\"state\":{},\"task_id\":{}}}",
        checkpoint.attempt,
        serialize_value(&checkpoint.data),
        quote(&checkpoint.input_digest),
        quote(&checkpoint.revision),
        quote(&checkpoint.state),
        quote(&checkpoint.task_id),
    ))
}

#[allow(clippy::too_many_arguments)]
fn build_execution(
    request: &TaskRequest,
    terminal: String,
    primary: Option<String>,
    output: Option<TaskValue>,
    attempts: u8,
    replayed: bool,
    runtime: Runtime<'_>,
) -> TaskExecution {
    let effects_digest = digest(&serialize_effects(runtime.effects));
    let output_digest = output.as_ref().map(|value| digest(&serialize_value(value)));
    let trace_digest = digest(&format!(
        "{{\"cleanup_events\":{},\"trace\":{}}}",
        serialize_strings(&runtime.cleanup_events),
        serialize_trace(&runtime.trace),
    ));
    let mut receipt = TaskReceipt {
        schema: NATIVE_TASK_RECEIPT_SCHEMA.to_owned(),
        runtime: NATIVE_TASK_RUNTIME.to_owned(),
        task_id: request.task_id.clone(),
        request_digest: request.request_digest.clone(),
        attempts,
        performer_calls: runtime.performer_calls,
        replayed,
        cancel_reason: runtime.lifecycle.reason,
        cleanup_events: runtime.cleanup_events,
        effect_count: runtime.effects.len(),
        effects_digest,
        output_digest,
        trace: runtime.trace,
        trace_digest,
        receipt_digest: String::new(),
    };
    receipt.receipt_digest = digest(&serialize_receipt(&receipt));
    let error = primary.map(|code| TaskDiagnostic { code });
    let mut result = TaskExecution {
        schema: NATIVE_TASK_RESULT_SCHEMA.to_owned(),
        terminal,
        error,
        output,
        receipt,
        result_digest: String::new(),
    };
    result.result_digest = digest(&serialize_result(&result));
    result
}

fn serialize_receipt(receipt: &TaskReceipt) -> String {
    format!(
        "{{\"attempts\":{},\"cancel_reason\":{},\"cleanup_events\":{},\"effect_count\":{},\"effects_digest\":{},\"output_digest\":{},\"performer_calls\":{},\"replayed\":{},\"request_digest\":{},\"runtime\":{},\"schema\":{},\"task_id\":{},\"trace\":{},\"trace_digest\":{}}}",
        receipt.attempts,
        receipt
            .cancel_reason
            .as_ref()
            .map_or_else(|| "null".to_owned(), |reason| quote(reason.name())),
        serialize_strings(&receipt.cleanup_events),
        receipt.effect_count,
        quote(&receipt.effects_digest),
        receipt
            .output_digest
            .as_ref()
            .map_or_else(|| "null".to_owned(), |value| quote(value)),
        receipt.performer_calls,
        receipt.replayed,
        quote(&receipt.request_digest),
        quote(&receipt.runtime),
        quote(&receipt.schema),
        quote(&receipt.task_id),
        serialize_trace(&receipt.trace),
        quote(&receipt.trace_digest),
    )
}

fn serialize_result(result: &TaskExecution) -> String {
    format!(
        "{{\"error\":{},\"output\":{},\"receipt_digest\":{},\"schema\":{},\"terminal\":{}}}",
        result.error.as_ref().map_or_else(
            || "null".to_owned(),
            |error| format!("{{\"code\":{}}}", quote(&error.code))
        ),
        result
            .output
            .as_ref()
            .map_or_else(|| "null".to_owned(), serialize_value),
        quote(&result.receipt.receipt_digest),
        quote(&result.schema),
        quote(&result.terminal),
    )
}

fn serialize_trace(trace: &[TaskTraceEntry]) -> String {
    let entries = trace
        .iter()
        .map(|entry| match entry {
            TaskTraceEntry::AttemptStart {
                attempt,
                backoff_ms,
            } => format!(
                "{{\"attempt\":{},\"backoff_ms\":{},\"kind\":\"attempt-start\"}}",
                attempt, backoff_ms
            ),
            TaskTraceEntry::AttemptError { attempt, error } => format!(
                "{{\"attempt\":{},\"error\":{{\"code\":{},\"message\":{}}},\"kind\":\"attempt-error\"}}",
                attempt,
                quote(&error.code),
                quote(&error.message),
            ),
            TaskTraceEntry::Retry {
                attempt,
                checkpoint_digest,
            } => format!(
                "{{\"attempt\":{},\"checkpoint_digest\":{},\"kind\":\"retry\"}}",
                attempt,
                quote(checkpoint_digest),
            ),
            TaskTraceEntry::Success {
                attempt,
                effect_key,
            } => format!(
                "{{\"attempt\":{},\"effect_key\":{},\"kind\":\"success\"}}",
                attempt,
                quote(effect_key),
            ),
            TaskTraceEntry::Replay { task_id } => format!(
                "{{\"kind\":\"replay\",\"task_id\":{}}}",
                quote(task_id)
            ),
            TaskTraceEntry::CancelBeforeStart { task_id } => format!(
                "{{\"kind\":\"cancel-before-start\",\"task_id\":{}}}",
                quote(task_id)
            ),
            TaskTraceEntry::CancelAfterStart { attempt } => format!(
                "{{\"attempt\":{},\"kind\":\"cancel-after-start\"}}",
                attempt
            ),
            TaskTraceEntry::ResourceClose => "{\"kind\":\"resource-close\"}".to_owned(),
        })
        .collect::<Vec<_>>();
    format!("[{}]", entries.join(","))
}

fn serialize_effects(effects: &BTreeMap<String, EffectRecord>) -> String {
    let entries = effects
        .iter()
        .map(|(key, effect)| {
            format!(
                "[{},{{\"attempt\":{},\"effect_key\":{},\"output\":{},\"payload\":{},\"task_id\":{}}}]",
                quote(key),
                effect.attempt,
                quote(&effect.effect_key),
                serialize_value(&effect.output),
                serialize_value(&effect.payload),
                quote(&effect.task_id),
            )
        })
        .collect::<Vec<_>>();
    format!("[{}]", entries.join(","))
}

fn serialize_strings(values: &[String]) -> String {
    format!(
        "[{}]",
        values
            .iter()
            .map(|value| quote(value))
            .collect::<Vec<_>>()
            .join(",")
    )
}

fn serialize_value(value: &TaskValue) -> String {
    match value {
        TaskValue::Null => "null".to_owned(),
        TaskValue::Bool(value) => value.to_string(),
        TaskValue::Number(value) => value.clone(),
        TaskValue::String(value) => quote(value),
        TaskValue::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(serialize_value)
                .collect::<Vec<_>>()
                .join(",")
        ),
        TaskValue::Object(values) => format!(
            "{{{}}}",
            values
                .iter()
                .map(|(key, value)| format!("{}:{}", quote(key), serialize_value(value)))
                .collect::<Vec<_>>()
                .join(",")
        ),
    }
}

fn validate_value(value: &TaskValue) -> Result<(), &'static str> {
    match value {
        TaskValue::Null | TaskValue::Bool(_) | TaskValue::String(_) => Ok(()),
        TaskValue::Number(value) => {
            let bytes = value.as_bytes();
            let digits = bytes.strip_prefix(b"-").unwrap_or(bytes);
            if digits.is_empty()
                || !digits.iter().all(u8::is_ascii_digit)
                || (digits.len() > 1 && digits[0] == b'0')
                || value == "-0"
            {
                return Err("invalid-task-value");
            }
            Ok(())
        }
        TaskValue::Array(values) => {
            for value in values {
                validate_value(value)?;
            }
            Ok(())
        }
        TaskValue::Object(values) => {
            if values.keys().any(|key| key.is_empty()) {
                return Err("invalid-task-value");
            }
            for value in values.values() {
                validate_value(value)?;
            }
            Ok(())
        }
    }
}

fn digest(value: &str) -> String {
    format!("sha256:{}", sha256_hex(value.as_bytes()))
}

fn valid_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_name(value: &str) -> bool {
    let mut bytes = value.bytes();
    matches!(bytes.next(), Some(b'a'..=b'z'))
        && bytes.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

fn valid_semantic_name(value: &str) -> bool {
    !value.is_empty() && value.split('.').all(valid_name)
}

fn valid_uid(value: &str) -> bool {
    value.len() == 26
        && value.bytes().enumerate().all(|(index, byte)| {
            if index == 25 {
                b"aeimquy4".contains(&byte)
            } else {
                byte.is_ascii_lowercase() || (b'2'..=b'7').contains(&byte)
            }
        })
}
