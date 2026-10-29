use std::process::Command;

fn server_smoke_command() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_revia"));
    command.arg("server-smoke").env_clear().env("PATH", "");
    #[cfg(windows)]
    for key in ["SystemRoot", "WINDIR", "TEMP", "TMP"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command
}

#[test]
fn native_cli_server_smoke_uses_loopback_and_emits_deterministic_receipt() {
    let first = server_smoke_command().output().unwrap();
    assert!(
        first.status.success(),
        "first server-smoke failed: status={:?}, stdout={}, stderr={}",
        first.status,
        String::from_utf8_lossy(&first.stdout),
        String::from_utf8_lossy(&first.stderr)
    );
    assert_eq!(
        String::from_utf8(first.stdout.clone()).unwrap(),
        "{\"body\":\"{\\\"status\\\":\\\"ok\\\"}\",\"route_id\":\"health\",\"schema\":\"re.native-server-smoke@0.1.0\",\"status\":200,\"transport\":\"loopback\"}\n"
    );

    let second = server_smoke_command().output().unwrap();
    assert_eq!(second.stdout, first.stdout);
    assert!(first.stderr.is_empty());
}
