use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use crate::canonical_json::{JsonValue, canonicalize};

pub const HTTP_SERVER_SCHEMA: &str = "re.native-http-server@0.1.0";
pub const JSON_SCHEMA: &str = "re.native-json-codec@0.1.0";
pub const SQLITE_SCHEMA: &str = "re.native-sqlite-cli@0.1.0";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ServerError {
    InvalidRequest,
    UnsupportedHttpVersion,
    InvalidMethod,
    InvalidPath,
    InvalidHeader,
    RequestBodyTooLarge,
    ResponseBodyTooLarge,
    RouteNotFound,
    Cancelled,
    InvalidStatus,
    InvalidResponseHeader,
    JsonSchemaViolation,
    UnknownJsonSchema,
    InvalidJson,
    InvalidSql,
    SqliteUnavailable,
    SqliteFailure,
    InvalidSqlParameter,
    InvalidDatabasePath,
    TransactionRolledBack,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpLimits {
    pub max_request_bytes: usize,
    pub max_request_body_bytes: usize,
    pub max_response_body_bytes: usize,
}

impl HttpLimits {
    pub fn new(
        max_request_bytes: usize,
        max_request_body_bytes: usize,
        max_response_body_bytes: usize,
    ) -> Result<Self, ServerError> {
        if max_request_bytes == 0
            || max_request_body_bytes == 0
            || max_response_body_bytes == 0
            || max_request_body_bytes > max_request_bytes
        {
            return Err(ServerError::InvalidRequest);
        }
        Ok(Self {
            max_request_bytes,
            max_request_body_bytes,
            max_response_body_bytes,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpRequest {
    pub method: String,
    pub path: String,
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
}

impl HttpResponse {
    pub fn new(status: u16, headers: BTreeMap<String, String>, body: Vec<u8>) -> Self {
        Self {
            status,
            headers,
            body,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpRoute {
    pub method: String,
    pub path: String,
    pub route_id: String,
}

impl HttpRoute {
    pub fn new(
        method: impl Into<String>,
        path: impl Into<String>,
        route_id: impl Into<String>,
    ) -> Result<Self, ServerError> {
        let route = Self {
            method: method.into(),
            path: path.into(),
            route_id: route_id.into(),
        };
        validate_method(&route.method)?;
        validate_path(&route.path)?;
        if route.route_id.is_empty() {
            return Err(ServerError::InvalidRequest);
        }
        Ok(route)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpRouteMatch {
    pub route_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpRouter {
    routes: Vec<HttpRoute>,
}

impl HttpRouter {
    pub fn new(mut routes: Vec<HttpRoute>) -> Result<Self, ServerError> {
        routes.sort_by(|left, right| {
            left.method
                .as_bytes()
                .cmp(right.method.as_bytes())
                .then_with(|| left.path.as_bytes().cmp(right.path.as_bytes()))
                .then_with(|| left.route_id.as_bytes().cmp(right.route_id.as_bytes()))
        });
        for pair in routes.windows(2) {
            if pair[0].method == pair[1].method && pair[0].path == pair[1].path {
                return Err(ServerError::InvalidRequest);
            }
        }
        Ok(Self { routes })
    }

    pub fn route(&self, request: &HttpRequest) -> Result<HttpRouteMatch, ServerError> {
        self.routes
            .iter()
            .find(|route| route.method == request.method && route.path == request.path)
            .map(|route| HttpRouteMatch {
                route_id: route.route_id.clone(),
            })
            .ok_or(ServerError::RouteNotFound)
    }
}

pub fn parse_http_request(input: &[u8], limits: &HttpLimits) -> Result<HttpRequest, ServerError> {
    if input.len() > limits.max_request_bytes {
        return Err(ServerError::RequestBodyTooLarge);
    }
    let header_end = input
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or(ServerError::InvalidRequest)?;
    let header_bytes = &input[..header_end];
    let body = &input[header_end + 4..];
    let mut lines = header_bytes.split(|byte| *byte == b'\n');
    let request_line = lines.next().ok_or(ServerError::InvalidRequest)?;
    let request_line = strip_cr(request_line)?;
    let mut parts = request_line.split(|byte| *byte == b' ');
    let method = text_token(parts.next().ok_or(ServerError::InvalidRequest)?)?;
    let path = text_path(parts.next().ok_or(ServerError::InvalidRequest)?)?;
    let version = parts.next();
    if version != Some(b"HTTP/1.1") || parts.next().is_some() {
        return Err(ServerError::UnsupportedHttpVersion);
    }
    let mut headers = BTreeMap::new();
    for line in lines {
        let line = strip_optional_cr(line);
        if line.is_empty() {
            return Err(ServerError::InvalidHeader);
        }
        let separator = line
            .iter()
            .position(|byte| *byte == b':')
            .ok_or(ServerError::InvalidHeader)?;
        let name = text_header_name(&line[..separator])?;
        let value = text_header_value(&line[separator + 1..])?;
        if headers.insert(name, value).is_some() {
            return Err(ServerError::InvalidHeader);
        }
    }
    let content_length = match headers.get("content-length") {
        Some(value) => value
            .parse::<usize>()
            .map_err(|_| ServerError::InvalidRequest)?,
        None => 0,
    };
    if content_length > limits.max_request_body_bytes {
        return Err(ServerError::RequestBodyTooLarge);
    }
    if content_length != body.len() {
        return Err(ServerError::InvalidRequest);
    }
    Ok(HttpRequest {
        method,
        path,
        headers,
        body: body.to_vec(),
    })
}

pub fn serialize_http_response(
    response: &HttpResponse,
    limits: &HttpLimits,
) -> Result<Vec<u8>, ServerError> {
    if !(100..=599).contains(&response.status) {
        return Err(ServerError::InvalidStatus);
    }
    if response.body.len() > limits.max_response_body_bytes {
        return Err(ServerError::ResponseBodyTooLarge);
    }
    let mut headers = BTreeMap::new();
    for (name, value) in &response.headers {
        let normalized = text_header_name(name.as_bytes())?;
        let value = text_header_value(value.as_bytes())?;
        if normalized == "content-length" || normalized == "connection" {
            return Err(ServerError::InvalidResponseHeader);
        }
        if headers.insert(normalized, value).is_some() {
            return Err(ServerError::InvalidResponseHeader);
        }
    }
    headers.insert("connection".to_owned(), "close".to_owned());
    headers.insert("content-length".to_owned(), response.body.len().to_string());
    let mut output = format!(
        "HTTP/1.1 {} {}\r\n",
        response.status,
        status_reason(response.status)
    )
    .into_bytes();
    let mut ordered_headers = Vec::new();
    if let Some(value) = headers.remove("content-length") {
        ordered_headers.push(("content-length".to_owned(), value));
    }
    ordered_headers.extend(headers.into_iter().filter(|(name, _)| name != "connection"));
    ordered_headers.push(("connection".to_owned(), "close".to_owned()));
    for (name, value) in ordered_headers {
        output.extend_from_slice(header_title_case(name.as_bytes()).as_bytes());
        output.extend_from_slice(b": ");
        output.extend_from_slice(value.as_bytes());
        output.extend_from_slice(b"\r\n");
    }
    output.extend_from_slice(b"\r\n");
    output.extend_from_slice(&response.body);
    Ok(output)
}

pub trait HttpHandler {
    fn handle(
        &mut self,
        route_id: &str,
        request: &HttpRequest,
    ) -> Result<HttpResponse, ServerError>;
}

#[derive(Clone, Debug, Default)]
pub struct ServerCancellation {
    cancelled: Arc<AtomicBool>,
}

impl ServerCancellation {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServeReceipt {
    pub route_id: String,
    pub status: u16,
}

pub fn serve_once(
    listener: &TcpListener,
    router: &HttpRouter,
    handler: &mut dyn HttpHandler,
    limits: &HttpLimits,
    cancellation: &ServerCancellation,
) -> Result<ServeReceipt, ServerError> {
    if cancellation.is_cancelled() {
        return Err(ServerError::Cancelled);
    }
    let (mut stream, _) = listener.accept().map_err(|_| ServerError::InvalidRequest)?;
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(2)))
        .map_err(|_| ServerError::InvalidRequest)?;
    let input = read_request(&mut stream, limits)?;
    if cancellation.is_cancelled() {
        return Err(ServerError::Cancelled);
    }
    let request = parse_http_request(&input, limits)?;
    let route = match router.route(&request) {
        Ok(route) => route,
        Err(ServerError::RouteNotFound) => {
            let response = HttpResponse::new(404, BTreeMap::new(), Vec::new());
            let bytes = serialize_http_response(&response, limits)?;
            stream
                .write_all(&bytes)
                .map_err(|_| ServerError::InvalidRequest)?;
            stream
                .shutdown(std::net::Shutdown::Both)
                .map_err(|_| ServerError::InvalidRequest)?;
            return Ok(ServeReceipt {
                route_id: String::new(),
                status: 404,
            });
        }
        Err(error) => return Err(error),
    };
    if cancellation.is_cancelled() {
        return Err(ServerError::Cancelled);
    }
    let response = handler.handle(&route.route_id, &request)?;
    if cancellation.is_cancelled() {
        return Err(ServerError::Cancelled);
    }
    let status = response.status;
    let bytes = serialize_http_response(&response, limits)?;
    stream
        .write_all(&bytes)
        .map_err(|_| ServerError::InvalidRequest)?;
    stream
        .shutdown(std::net::Shutdown::Both)
        .map_err(|_| ServerError::InvalidRequest)?;
    Ok(ServeReceipt {
        route_id: route.route_id,
        status,
    })
}

fn read_request(stream: &mut TcpStream, limits: &HttpLimits) -> Result<Vec<u8>, ServerError> {
    let mut input = Vec::new();
    let mut buffer = [0_u8; 1024];
    loop {
        let read = stream
            .read(&mut buffer)
            .map_err(|_| ServerError::InvalidRequest)?;
        if read == 0 {
            break;
        }
        input.extend_from_slice(&buffer[..read]);
        if input.len() > limits.max_request_bytes {
            return Err(ServerError::RequestBodyTooLarge);
        }
        if input.windows(4).any(|window| window == b"\r\n\r\n") {
            let header_end = input
                .windows(4)
                .position(|window| window == b"\r\n\r\n")
                .ok_or(ServerError::InvalidRequest)?;
            if let Some(value) = content_length_from_header(&input[..header_end])? {
                if value > limits.max_request_body_bytes {
                    return Err(ServerError::RequestBodyTooLarge);
                }
                if input.len() >= header_end + 4 + value {
                    input.truncate(header_end + 4 + value);
                    return Ok(input);
                }
            } else {
                return Ok(input);
            }
        }
    }
    Ok(input)
}

fn content_length_from_header(header: &[u8]) -> Result<Option<usize>, ServerError> {
    for line in header.split(|byte| *byte == b'\n').skip(1) {
        let line = strip_optional_cr(line);
        let separator = line
            .iter()
            .position(|byte| *byte == b':')
            .ok_or(ServerError::InvalidHeader)?;
        if text_header_name(&line[..separator])? == "content-length" {
            return Ok(Some(
                text_header_value(&line[separator + 1..])?
                    .parse()
                    .map_err(|_| ServerError::InvalidRequest)?,
            ));
        }
    }
    Ok(None)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum JsonKind {
    Null,
    Bool,
    Number,
    String,
    Array,
    Object,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JsonSchema {
    kind: JsonKind,
    fields: BTreeMap<String, JsonKind>,
}

impl JsonSchema {
    pub fn object(fields: BTreeMap<String, JsonKind>) -> Self {
        Self {
            kind: JsonKind::Object,
            fields,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct JsonSchemaRegistry {
    schemas: BTreeMap<String, JsonSchema>,
}

impl JsonSchemaRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(
        &mut self,
        identity: impl Into<String>,
        schema: JsonSchema,
    ) -> Result<(), ServerError> {
        let identity = identity.into();
        if identity.is_empty() || self.schemas.insert(identity, schema).is_some() {
            return Err(ServerError::JsonSchemaViolation);
        }
        Ok(())
    }

    pub fn encode(&self, identity: &str, value: &JsonValue) -> Result<String, ServerError> {
        let schema = self
            .schemas
            .get(identity)
            .ok_or(ServerError::UnknownJsonSchema)?;
        validate_json(schema, value)?;
        Ok(canonicalize(value))
    }

    pub fn decode(&self, identity: &str, payload: &str) -> Result<JsonValue, ServerError> {
        let schema = self
            .schemas
            .get(identity)
            .ok_or(ServerError::UnknownJsonSchema)?;
        let value = parse_json(payload)?;
        validate_json(schema, &value)?;
        Ok(value)
    }
}

fn validate_json(schema: &JsonSchema, value: &JsonValue) -> Result<(), ServerError> {
    if !matches_kind(&schema.kind, value) {
        return Err(ServerError::JsonSchemaViolation);
    }
    if schema.kind == JsonKind::Object {
        let JsonValue::Object(entries) = value else {
            return Err(ServerError::JsonSchemaViolation);
        };
        let mut names = BTreeSet::new();
        for (name, entry) in entries {
            if !names.insert(name) {
                return Err(ServerError::JsonSchemaViolation);
            }
            let field = schema
                .fields
                .get(name)
                .ok_or(ServerError::JsonSchemaViolation)?;
            if !matches_kind(field, entry) {
                return Err(ServerError::JsonSchemaViolation);
            }
        }
        if names.len() != schema.fields.len() {
            return Err(ServerError::JsonSchemaViolation);
        }
    }
    Ok(())
}

fn matches_kind(kind: &JsonKind, value: &JsonValue) -> bool {
    matches!(
        (kind, value),
        (JsonKind::Null, JsonValue::Null)
            | (JsonKind::Bool, JsonValue::Bool(_))
            | (JsonKind::Number, JsonValue::Number(_))
            | (JsonKind::String, JsonValue::String(_))
            | (JsonKind::Array, JsonValue::Array(_))
            | (JsonKind::Object, JsonValue::Object(_))
    )
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SqlValue {
    Text(String),
    Integer(i64),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SqlStatement {
    pub sql: String,
    pub parameters: Vec<SqlValue>,
}

impl SqlStatement {
    pub fn new(sql: impl Into<String>, parameters: Vec<SqlValue>) -> Result<Self, ServerError> {
        let statement = Self {
            sql: sql.into(),
            parameters,
        };
        validate_sql(&statement.sql)?;
        Ok(statement)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SqlRow(pub BTreeMap<String, SqlValue>);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SqlTransactionResult {
    pub affected_rows: usize,
}

#[derive(Clone, Debug)]
pub struct SqliteCliDriver {
    database: PathBuf,
    executable: PathBuf,
}

impl SqliteCliDriver {
    pub fn new(database: PathBuf, executable: PathBuf) -> Result<Self, ServerError> {
        validate_database_path(&database)?;
        if executable.as_os_str().is_empty() {
            return Err(ServerError::SqliteUnavailable);
        }
        Ok(Self {
            database,
            executable,
        })
    }

    pub fn transaction(
        &self,
        statements: &[SqlStatement],
    ) -> Result<SqlTransactionResult, ServerError> {
        if statements.is_empty() {
            return Err(ServerError::InvalidSql);
        }
        let mut script = String::from(".bail on\n.parameter init\n");
        script.push_str("BEGIN;\n");
        for statement in statements {
            validate_sql(&statement.sql)?;
            if !is_transaction_sql(&statement.sql) {
                return Err(ServerError::TransactionRolledBack);
            }
            append_parameters(&mut script, &statement.parameters)?;
            script.push_str(&statement.sql);
            script.push_str(";\n");
        }
        script.push_str("COMMIT;\n");
        let output = self.run_script(&script)?;
        if !output.status.success() {
            return Err(ServerError::TransactionRolledBack);
        }
        Ok(SqlTransactionResult {
            affected_rows: statements
                .iter()
                .filter(|statement| is_mutating_sql(&statement.sql))
                .count(),
        })
    }

    pub fn query(
        &self,
        sql: &str,
        parameters: &[SqlValue],
    ) -> Result<Vec<BTreeMap<String, SqlValue>>, ServerError> {
        validate_sql(sql)?;
        if !sql.trim_start().to_ascii_lowercase().starts_with("select") {
            return Err(ServerError::InvalidSql);
        }
        let mut script = String::from(".bail on\n.parameter init\n");
        append_parameters(&mut script, parameters)?;
        script.push_str(".mode json\n");
        script.push_str(sql);
        script.push_str(";\n");
        let output = self.run_script(&script)?;
        if !output.status.success() {
            return Err(ServerError::SqliteFailure);
        }
        parse_query_rows(&output.stdout)
    }

    fn run_script(&self, script: &str) -> Result<std::process::Output, ServerError> {
        if let Some(parent) = self.database.parent() {
            fs::create_dir_all(parent).map_err(|_| ServerError::InvalidDatabasePath)?;
        }
        let mut command = Command::new(&self.executable);
        command
            .arg(&self.database)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
            .output_with_input(script.as_bytes())
            .map_err(|_| ServerError::SqliteUnavailable)
    }
}

trait CommandInput {
    fn output_with_input(self, input: &[u8]) -> std::io::Result<std::process::Output>;
}

impl CommandInput for Command {
    fn output_with_input(mut self, input: &[u8]) -> std::io::Result<std::process::Output> {
        let mut child = self.spawn()?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(input)?;
        }
        child.wait_with_output()
    }
}

fn validate_database_path(path: &Path) -> Result<(), ServerError> {
    if !path.is_absolute()
        || path.as_os_str().is_empty()
        || path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(ServerError::InvalidDatabasePath);
    }
    if path.exists()
        && (path.is_dir()
            || fs::symlink_metadata(path)
                .map(|metadata| metadata.file_type().is_symlink())
                .unwrap_or(true))
    {
        return Err(ServerError::InvalidDatabasePath);
    }
    Ok(())
}

fn append_parameters(script: &mut String, parameters: &[SqlValue]) -> Result<(), ServerError> {
    for (index, parameter) in parameters.iter().enumerate() {
        let name = format!("@p{index}");
        let value = match parameter {
            SqlValue::Text(value) => {
                if value.contains('\0') {
                    return Err(ServerError::InvalidSqlParameter);
                }
                format!("\"{}\"", escape_sqlite_dot_string(value))
            }
            SqlValue::Integer(value) => value.to_string(),
        };
        script.push_str(".parameter set ");
        script.push_str(&name);
        script.push(' ');
        script.push_str(&value);
        script.push('\n');
    }
    Ok(())
}

fn escape_sqlite_dot_string(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t")
}

fn parse_query_rows(bytes: &[u8]) -> Result<Vec<BTreeMap<String, SqlValue>>, ServerError> {
    let text = std::str::from_utf8(bytes).map_err(|_| ServerError::SqliteFailure)?;
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    let value = parse_json(text)?;
    let JsonValue::Array(rows) = value else {
        return Err(ServerError::SqliteFailure);
    };
    rows.into_iter()
        .map(|row| {
            let JsonValue::Object(entries) = row else {
                return Err(ServerError::SqliteFailure);
            };
            entries
                .into_iter()
                .map(|(key, value)| {
                    let value = match value {
                        JsonValue::String(value) => SqlValue::Text(value),
                        JsonValue::Number(value) => SqlValue::Integer(
                            value.parse().map_err(|_| ServerError::SqliteFailure)?,
                        ),
                        _ => return Err(ServerError::SqliteFailure),
                    };
                    Ok((key, value))
                })
                .collect()
        })
        .collect()
}

fn validate_sql(sql: &str) -> Result<(), ServerError> {
    if sql.is_empty()
        || sql.contains('\0')
        || sql.contains("--")
        || sql.contains("/*")
        || sql.contains("*/")
        || sql.matches(';').count() > 0
    {
        return Err(ServerError::InvalidSql);
    }
    if sql.as_bytes().iter().any(|byte| byte.is_ascii_control()) {
        return Err(ServerError::InvalidSql);
    }
    let keyword = sql
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(
        keyword.as_str(),
        "attach" | "detach" | "pragma" | "vacuum" | "load" | ".import" | ".open"
    ) {
        return Err(ServerError::InvalidSql);
    }
    Ok(())
}

fn is_mutating_sql(sql: &str) -> bool {
    matches!(
        sql.split_whitespace()
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "insert" | "update" | "delete" | "replace"
    )
}

fn is_transaction_sql(sql: &str) -> bool {
    matches!(
        sql.split_whitespace()
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "create" | "insert" | "update" | "delete" | "replace"
    )
}

fn validate_method(value: &str) -> Result<(), ServerError> {
    if value.is_empty()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte))
    {
        return Err(ServerError::InvalidMethod);
    }
    Ok(())
}

fn validate_path(value: &str) -> Result<(), ServerError> {
    if value.is_empty()
        || !value.starts_with('/')
        || value.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err(ServerError::InvalidPath);
    }
    Ok(())
}

fn text_token(bytes: &[u8]) -> Result<String, ServerError> {
    let value = std::str::from_utf8(bytes).map_err(|_| ServerError::InvalidRequest)?;
    validate_method(value)?;
    Ok(value.to_owned())
}

fn text_path(bytes: &[u8]) -> Result<String, ServerError> {
    let value = std::str::from_utf8(bytes).map_err(|_| ServerError::InvalidRequest)?;
    validate_path(value)?;
    Ok(value.to_owned())
}

fn text_header_name(bytes: &[u8]) -> Result<String, ServerError> {
    let value = std::str::from_utf8(bytes)
        .map_err(|_| ServerError::InvalidHeader)?
        .to_ascii_lowercase();
    if value.is_empty()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte))
    {
        return Err(ServerError::InvalidHeader);
    }
    Ok(value)
}

fn text_header_value(bytes: &[u8]) -> Result<String, ServerError> {
    let value = std::str::from_utf8(bytes)
        .map_err(|_| ServerError::InvalidHeader)?
        .trim()
        .to_owned();
    if value
        .bytes()
        .any(|byte| byte == b'\r' || byte == b'\n' || byte.is_ascii_control())
    {
        return Err(ServerError::InvalidHeader);
    }
    Ok(value)
}

fn strip_cr(bytes: &[u8]) -> Result<&[u8], ServerError> {
    bytes.strip_suffix(b"\r").ok_or(ServerError::InvalidRequest)
}

fn strip_optional_cr(bytes: &[u8]) -> &[u8] {
    bytes.strip_suffix(b"\r").unwrap_or(bytes)
}

fn status_reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        400 => "Bad Request",
        404 => "Not Found",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "Status",
    }
}

fn header_title_case(name: &[u8]) -> String {
    let mut output = String::new();
    let mut uppercase = true;
    for byte in name {
        if *byte == b'-' {
            uppercase = true;
            output.push('-');
        } else if uppercase {
            output.push((*byte as char).to_ascii_uppercase());
            uppercase = false;
        } else {
            output.push(*byte as char);
        }
    }
    output
}

fn parse_json(source: &str) -> Result<JsonValue, ServerError> {
    if !source.is_char_boundary(source.len()) {
        return Err(ServerError::InvalidJson);
    }
    let mut parser = JsonParser {
        bytes: source.as_bytes(),
        index: 0,
    };
    let value = parser.value()?;
    parser.ws();
    if parser.index != parser.bytes.len() {
        return Err(ServerError::InvalidJson);
    }
    Ok(value)
}

struct JsonParser<'a> {
    bytes: &'a [u8],
    index: usize,
}

impl<'a> JsonParser<'a> {
    fn value(&mut self) -> Result<JsonValue, ServerError> {
        self.ws();
        match self.bytes.get(self.index).copied() {
            Some(b'n') => self.literal(b"null", JsonValue::Null),
            Some(b't') => self.literal(b"true", JsonValue::Bool(true)),
            Some(b'f') => self.literal(b"false", JsonValue::Bool(false)),
            Some(b'"') => Ok(JsonValue::String(self.string()?)),
            Some(b'[') => self.array(),
            Some(b'{') => self.object(),
            Some(byte) if byte == b'-' || byte.is_ascii_digit() => self.number(),
            _ => Err(ServerError::InvalidJson),
        }
    }

    fn literal(&mut self, expected: &[u8], value: JsonValue) -> Result<JsonValue, ServerError> {
        if self.bytes.get(self.index..self.index + expected.len()) != Some(expected) {
            return Err(ServerError::InvalidJson);
        }
        self.index += expected.len();
        Ok(value)
    }

    fn string(&mut self) -> Result<String, ServerError> {
        self.index += 1;
        let mut output = Vec::new();
        while let Some(byte) = self.bytes.get(self.index).copied() {
            self.index += 1;
            match byte {
                b'"' => return String::from_utf8(output).map_err(|_| ServerError::InvalidJson),
                b'\\' => {
                    let escaped = self
                        .bytes
                        .get(self.index)
                        .copied()
                        .ok_or(ServerError::InvalidJson)?;
                    self.index += 1;
                    match escaped {
                        b'"' => output.push(b'"'),
                        b'\\' => output.push(b'\\'),
                        b'/' => output.push(b'/'),
                        b'b' => output.push(8),
                        b'f' => output.push(12),
                        b'n' => output.push(b'\n'),
                        b'r' => output.push(b'\r'),
                        b't' => output.push(b'\t'),
                        b'u' => {
                            let hex = self
                                .bytes
                                .get(self.index..self.index + 4)
                                .ok_or(ServerError::InvalidJson)?;
                            let code = hex
                                .iter()
                                .try_fold(0_u32, |value, byte| {
                                    value.checked_mul(16)?.checked_add(match byte {
                                        b'0'..=b'9' => u32::from(*byte - b'0'),
                                        b'a'..=b'f' => u32::from(*byte - b'a' + 10),
                                        b'A'..=b'F' => u32::from(*byte - b'A' + 10),
                                        _ => return None,
                                    })
                                })
                                .ok_or(ServerError::InvalidJson)?;
                            let character = char::from_u32(code).ok_or(ServerError::InvalidJson)?;
                            let mut encoded = [0_u8; 4];
                            output
                                .extend_from_slice(character.encode_utf8(&mut encoded).as_bytes());
                            self.index += 4;
                        }
                        _ => return Err(ServerError::InvalidJson),
                    }
                }
                0..=31 => return Err(ServerError::InvalidJson),
                _ => {
                    let width = utf8_width(byte).ok_or(ServerError::InvalidJson)?;
                    let start = self.index - 1;
                    let end = start.checked_add(width).ok_or(ServerError::InvalidJson)?;
                    let bytes = self.bytes.get(start..end).ok_or(ServerError::InvalidJson)?;
                    if std::str::from_utf8(bytes).is_err() {
                        return Err(ServerError::InvalidJson);
                    }
                    output.extend_from_slice(bytes);
                    self.index = end;
                }
            }
        }
        Err(ServerError::InvalidJson)
    }

    fn number(&mut self) -> Result<JsonValue, ServerError> {
        let start = self.index;
        if self.bytes.get(self.index) == Some(&b'-') {
            self.index += 1;
        }
        match self.bytes.get(self.index).copied() {
            Some(b'0') => {
                self.index += 1;
                if self
                    .bytes
                    .get(self.index)
                    .is_some_and(|byte| byte.is_ascii_digit())
                {
                    return Err(ServerError::InvalidJson);
                }
            }
            Some(b'1'..=b'9') => {
                self.index += 1;
                while self
                    .bytes
                    .get(self.index)
                    .copied()
                    .is_some_and(|byte| byte.is_ascii_digit())
                {
                    self.index += 1;
                }
            }
            _ => return Err(ServerError::InvalidJson),
        }
        if self.bytes.get(self.index) == Some(&b'.') {
            self.index += 1;
            let fraction_start = self.index;
            while self
                .bytes
                .get(self.index)
                .copied()
                .is_some_and(|byte| byte.is_ascii_digit())
            {
                self.index += 1;
            }
            if fraction_start == self.index {
                return Err(ServerError::InvalidJson);
            }
        }
        if self
            .bytes
            .get(self.index)
            .is_some_and(|byte| *byte == b'e' || *byte == b'E')
        {
            self.index += 1;
            if self
                .bytes
                .get(self.index)
                .is_some_and(|byte| *byte == b'+' || *byte == b'-')
            {
                self.index += 1;
            }
            let exponent_start = self.index;
            while self
                .bytes
                .get(self.index)
                .copied()
                .is_some_and(|byte| byte.is_ascii_digit())
            {
                self.index += 1;
            }
            if exponent_start == self.index {
                return Err(ServerError::InvalidJson);
            }
        }
        Ok(JsonValue::Number(
            std::str::from_utf8(&self.bytes[start..self.index])
                .map_err(|_| ServerError::InvalidJson)?
                .to_owned(),
        ))
    }

    fn array(&mut self) -> Result<JsonValue, ServerError> {
        self.index += 1;
        self.ws();
        let mut values = Vec::new();
        if self.bytes.get(self.index) == Some(&b']') {
            self.index += 1;
            return Ok(JsonValue::Array(values));
        }
        loop {
            values.push(self.value()?);
            self.ws();
            match self.bytes.get(self.index).copied() {
                Some(b',') => self.index += 1,
                Some(b']') => {
                    self.index += 1;
                    return Ok(JsonValue::Array(values));
                }
                _ => return Err(ServerError::InvalidJson),
            }
        }
    }

    fn object(&mut self) -> Result<JsonValue, ServerError> {
        self.index += 1;
        self.ws();
        let mut entries = Vec::new();
        if self.bytes.get(self.index) == Some(&b'}') {
            self.index += 1;
            return Ok(JsonValue::Object(entries));
        }
        loop {
            self.ws();
            if self.bytes.get(self.index) != Some(&b'"') {
                return Err(ServerError::InvalidJson);
            }
            let key = self.string()?;
            self.ws();
            if self.bytes.get(self.index) != Some(&b':') {
                return Err(ServerError::InvalidJson);
            }
            self.index += 1;
            entries.push((key, self.value()?));
            self.ws();
            match self.bytes.get(self.index).copied() {
                Some(b',') => self.index += 1,
                Some(b'}') => {
                    self.index += 1;
                    return Ok(JsonValue::Object(entries));
                }
                _ => return Err(ServerError::InvalidJson),
            }
        }
    }

    fn ws(&mut self) {
        while self
            .bytes
            .get(self.index)
            .copied()
            .is_some_and(|byte| byte == b' ' || byte == b'\n' || byte == b'\r' || byte == b'\t')
        {
            self.index += 1;
        }
    }
}

fn utf8_width(byte: u8) -> Option<usize> {
    match byte {
        0x00..=0x7f => Some(1),
        0xc2..=0xdf => Some(2),
        0xe0..=0xef => Some(3),
        0xf0..=0xf4 => Some(4),
        _ => None,
    }
}
