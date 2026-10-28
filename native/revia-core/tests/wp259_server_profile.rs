use std::{
    collections::BTreeMap,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::Arc,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use revia_core::{
    canonical_json::JsonValue,
    server::{
        HttpHandler, HttpLimits, HttpRequest, HttpResponse, HttpRoute, HttpRouter, JsonKind,
        JsonSchema, JsonSchemaRegistry, ServerCancellation, ServerError, SqlStatement, SqlValue,
        SqliteCliDriver, serve_once,
    },
};

#[test]
fn server_http_parser_router_and_response_are_bounded_and_deterministic() {
    let limits = HttpLimits::new(4096, 32, 64).unwrap();
    let request = revia_core::server::parse_http_request(
        b"POST /health HTTP/1.1\r\nHost: localhost\r\nContent-Length: 7\r\nX-Trace: abc\r\n\r\npayload",
        &limits,
    )
    .unwrap();
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, "/health");
    assert_eq!(request.body, b"payload");
    assert_eq!(request.headers.get("host").unwrap(), "localhost");

    let router =
        HttpRouter::new(vec![HttpRoute::new("POST", "/health", "health").unwrap()]).unwrap();
    assert_eq!(router.route(&request).unwrap().route_id, "health");

    let response = HttpResponse::new(
        200,
        BTreeMap::from([("content-type".to_owned(), "application/json".to_owned())]),
        b"{\"ok\":true}".to_vec(),
    );
    let first = revia_core::server::serialize_http_response(&response, &limits).unwrap();
    let second = revia_core::server::serialize_http_response(&response, &limits).unwrap();
    assert_eq!(first, second);
    assert!(
        String::from_utf8(first)
            .unwrap()
            .contains("Content-Length: 11\r\n")
    );

    let oversized = revia_core::server::parse_http_request(
        b"POST /health HTTP/1.1\r\nContent-Length: 33\r\n\r\n",
        &limits,
    )
    .unwrap_err();
    assert_eq!(oversized, ServerError::RequestBodyTooLarge);
}

#[test]
fn server_http_rejects_protocol_errors_and_cancellation_before_effect() {
    let limits = HttpLimits::new(128, 8, 16).unwrap();
    let invalid = revia_core::server::parse_http_request(
        b"GET / HTTP/1.0\r\nContent-Length: 0\r\n\r\n",
        &limits,
    )
    .unwrap_err();
    assert_eq!(invalid, ServerError::UnsupportedHttpVersion);

    let cancellation = ServerCancellation::new();
    cancellation.cancel();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let router = HttpRouter::new(vec![]).unwrap();
    let mut handler = NoopHandler;
    let error = serve_once(&listener, &router, &mut handler, &limits, &cancellation).unwrap_err();
    assert_eq!(error, ServerError::Cancelled);
}

#[test]
fn server_http_rejects_duplicate_headers_route_misses_and_oversized_responses() {
    let limits = HttpLimits::new(128, 8, 4).unwrap();
    let duplicate = revia_core::server::parse_http_request(
        b"GET / HTTP/1.1\r\nHost: localhost\r\nhost: duplicate\r\nContent-Length: 0\r\n\r\n",
        &limits,
    )
    .unwrap_err();
    assert_eq!(duplicate, ServerError::InvalidHeader);

    let request = revia_core::server::parse_http_request(
        b"GET /missing HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n",
        &limits,
    )
    .unwrap();
    let router =
        HttpRouter::new(vec![HttpRoute::new("GET", "/health", "health").unwrap()]).unwrap();
    assert_eq!(
        router.route(&request).unwrap_err(),
        ServerError::RouteNotFound
    );

    let response = HttpResponse::new(200, BTreeMap::new(), vec![1, 2, 3, 4, 5]);
    assert_eq!(
        revia_core::server::serialize_http_response(&response, &limits).unwrap_err(),
        ServerError::ResponseBodyTooLarge
    );
    let duplicate_response_headers = HttpResponse::new(
        200,
        BTreeMap::from([
            ("Content-Type".to_owned(), "application/json".to_owned()),
            ("content-type".to_owned(), "text/plain".to_owned()),
        ]),
        Vec::new(),
    );
    assert_eq!(
        revia_core::server::serialize_http_response(&duplicate_response_headers, &limits)
            .unwrap_err(),
        ServerError::InvalidResponseHeader
    );

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let router =
        HttpRouter::new(vec![HttpRoute::new("GET", "/health", "health").unwrap()]).unwrap();
    let cancellation = ServerCancellation::new();
    let mut handler = NoopHandler;
    let address = listener.local_addr().unwrap();
    let server = thread::spawn(move || {
        serve_once(&listener, &router, &mut handler, &limits, &cancellation).unwrap()
    });
    let mut client = TcpStream::connect(address).unwrap();
    client
        .write_all(b"GET /missing HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n")
        .unwrap();
    let mut output = Vec::new();
    client.read_to_end(&mut output).unwrap();
    let receipt = server.join().unwrap();
    assert_eq!(receipt.status, 404);
    assert_eq!(receipt.route_id, "");
    assert!(
        String::from_utf8(output)
            .unwrap()
            .starts_with("HTTP/1.1 404 Not Found\r\n")
    );
}

#[test]
fn native_http_loopback_uses_explicit_route_and_no_global_host_state() {
    let limits = HttpLimits::new(4096, 128, 256).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let router = Arc::new(
        HttpRouter::new(vec![HttpRoute::new("GET", "/health", "health").unwrap()]).unwrap(),
    );
    let cancellation = Arc::new(ServerCancellation::new());
    let server_router = Arc::clone(&router);
    let server_cancellation = Arc::clone(&cancellation);
    let server = thread::spawn(move || {
        let mut handler = HealthHandler;
        serve_once(
            &listener,
            &server_router,
            &mut handler,
            &limits,
            &server_cancellation,
        )
    });

    let mut client = TcpStream::connect(address).unwrap();
    client
        .write_all(b"GET /health HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n")
        .unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let mut output = Vec::new();
    client.read_to_end(&mut output).unwrap();
    let receipt = server.join().unwrap().unwrap();
    assert_eq!(receipt.route_id, "health");
    assert_eq!(receipt.status, 200);
    assert_eq!(
        String::from_utf8(output).unwrap(),
        "HTTP/1.1 200 OK\r\nContent-Length: 15\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"status\":\"ok\"}"
    );
}

#[test]
fn json_codec_is_schema_driven_and_canonical() {
    let mut registry = JsonSchemaRegistry::new();
    registry
        .register(
            "health.response@0.1.0",
            JsonSchema::object(BTreeMap::from([("status".to_owned(), JsonKind::String)])),
        )
        .unwrap();
    let value = JsonValue::Object(vec![(
        "status".to_owned(),
        JsonValue::String("ok".to_owned()),
    )]);
    assert_eq!(
        registry.encode("health.response@0.1.0", &value).unwrap(),
        "{\"status\":\"ok\"}"
    );
    assert_eq!(
        registry
            .decode("health.response@0.1.0", "{\"status\":\"ok\"}")
            .unwrap(),
        value
    );
    assert_eq!(
        registry
            .decode("health.response@0.1.0", "{\"extra\":true}")
            .unwrap_err(),
        ServerError::JsonSchemaViolation
    );
    assert_eq!(
        registry.decode("unknown@0.1.0", "{}").unwrap_err(),
        ServerError::UnknownJsonSchema
    );
    assert_eq!(
        registry
            .decode("health.response@0.1.0", "{\"status\":")
            .unwrap_err(),
        ServerError::InvalidJson
    );
    assert_eq!(
        registry
            .decode("health.response@0.1.0", "{\"status\":\"ok\",}")
            .unwrap_err(),
        ServerError::InvalidJson
    );
    registry
        .register(
            "number.response@0.1.0",
            JsonSchema::object(BTreeMap::from([("value".to_owned(), JsonKind::Number)])),
        )
        .unwrap();
    for payload in ["{\"value\":01}", "{\"value\":1.}", "{\"value\":1e}"] {
        assert_eq!(
            registry
                .decode("number.response@0.1.0", payload)
                .unwrap_err(),
            ServerError::InvalidJson
        );
    }
    let reordered = registry
        .decode("health.response@0.1.0", "{\"status\":\"ok\"}")
        .unwrap();
    assert_eq!(
        registry
            .encode("health.response@0.1.0", &reordered)
            .unwrap(),
        "{\"status\":\"ok\"}"
    );
}

#[test]
fn sqlite_cli_driver_executes_parameterized_transaction_without_sql_value_interpolation() {
    let root = std::env::temp_dir().join(format!(
        "revia-wp259-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let database = root.join("health.db");
    let driver = SqliteCliDriver::new(database.clone(), PathBuf::from("sqlite3")).unwrap();
    let result = driver
        .transaction(&[
            SqlStatement::new("CREATE TABLE health(status TEXT)", vec![]).unwrap(),
            SqlStatement::new(
                "INSERT INTO health(status) VALUES(@p0)",
                vec![SqlValue::Text("ok'); DROP TABLE health; --".to_owned())],
            )
            .unwrap(),
        ])
        .unwrap();
    assert_eq!(result.affected_rows, 1);

    let rows = driver
        .query(
            "SELECT status FROM health WHERE status = @p0",
            &[SqlValue::Text("ok'); DROP TABLE health; --".to_owned())],
        )
        .unwrap();
    assert_eq!(
        rows,
        vec![BTreeMap::from([(
            "status".to_owned(),
            SqlValue::Text("ok'); DROP TABLE health; --".to_owned()),
        )])]
    );
}

#[test]
fn sqlite_cli_driver_rolls_back_and_rejects_untrusted_paths_or_parameters() {
    let root = std::env::temp_dir().join(format!(
        "revia-wp259-rollback-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let database = root.join("rollback.db");
    let driver = SqliteCliDriver::new(database.clone(), PathBuf::from("sqlite3")).unwrap();
    let failed = driver.transaction(&[
        SqlStatement::new("CREATE TABLE transient(value TEXT)", vec![]).unwrap(),
        SqlStatement::new("NOT SQL", vec![]).unwrap(),
    ]);
    assert_eq!(failed.unwrap_err(), ServerError::TransactionRolledBack);
    let rows = driver
        .query(
            "SELECT name FROM sqlite_master WHERE name = @p0",
            &[SqlValue::Text("transient".to_owned())],
        )
        .unwrap();
    assert!(rows.is_empty());

    assert_eq!(
        SqliteCliDriver::new(PathBuf::from("relative.db"), PathBuf::from("sqlite3")).unwrap_err(),
        ServerError::InvalidDatabasePath
    );
    assert_eq!(
        SqlStatement::new("SELECT @p0", vec![SqlValue::Text("line\nbreak".to_owned())])
            .unwrap()
            .parameters
            .len(),
        1
    );
    let rows = driver
        .query(
            "SELECT @p0 AS value",
            &[SqlValue::Text("line\nbreak".to_owned())],
        )
        .unwrap();
    assert_eq!(
        rows,
        vec![BTreeMap::from([(
            "value".to_owned(),
            SqlValue::Text("line\nbreak".to_owned()),
        )])]
    );
    assert_eq!(
        SqliteCliDriver::new(database, PathBuf::from("/missing/revia-sqlite3"))
            .unwrap()
            .query("SELECT 1", &[])
            .unwrap_err(),
        ServerError::SqliteUnavailable
    );
    assert_eq!(
        SqlStatement::new("ATTACH DATABASE 'other.db' AS other", vec![]).unwrap_err(),
        ServerError::InvalidSql
    );
    assert_eq!(
        driver
            .query("SELECT @p0", &[SqlValue::Text("nul\0value".to_owned())],)
            .unwrap_err(),
        ServerError::InvalidSqlParameter
    );
}

struct HealthHandler;

impl HttpHandler for HealthHandler {
    fn handle(
        &mut self,
        route_id: &str,
        _request: &HttpRequest,
    ) -> Result<HttpResponse, ServerError> {
        assert_eq!(route_id, "health");
        Ok(HttpResponse::new(
            200,
            BTreeMap::from([("content-type".to_owned(), "application/json".to_owned())]),
            b"{\"status\":\"ok\"}".to_vec(),
        ))
    }
}

struct NoopHandler;

impl HttpHandler for NoopHandler {
    fn handle(
        &mut self,
        _route_id: &str,
        _request: &HttpRequest,
    ) -> Result<HttpResponse, ServerError> {
        unreachable!("cancelled server must not invoke handler")
    }
}
