use std::process::Command;

#[test]
fn native_cli_server_smoke_uses_loopback_and_emits_deterministic_receipt() {
    let first = Command::new(env!("CARGO_BIN_EXE_revia"))
        .arg("server-smoke")
        .env_clear()
        .env("PATH", "")
        .output()
        .unwrap();
    assert!(first.status.success());
    assert_eq!(
        String::from_utf8(first.stdout.clone()).unwrap(),
        "{\"body\":\"{\\\"status\\\":\\\"ok\\\"}\",\"route_id\":\"health\",\"schema\":\"re.native-server-smoke@0.1.0\",\"status\":200,\"transport\":\"loopback\"}\n"
    );

    let second = Command::new(env!("CARGO_BIN_EXE_revia"))
        .arg("server-smoke")
        .env_clear()
        .env("PATH", "")
        .output()
        .unwrap();
    assert_eq!(second.stdout, first.stdout);
    assert!(first.stderr.is_empty());
}
