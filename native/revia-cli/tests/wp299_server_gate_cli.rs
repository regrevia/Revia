use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

use revia_core::{
    digest::sha256_hex,
    project::{
        NativeDependency, NativeExport, NativeInterface, NativeModule, NativePackage,
        NativeProjectModule, serialize_project_manifest,
    },
    project_runtime::{
        NativeProjectExecutionPlan, NativeProjectExecutionStep, serialize_project_execution_plan,
    },
};

const PROFILE: &str = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const TOOLCHAIN: &str = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const INPUT: &str = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const CONTRACT: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SOURCE: &str = include_str!("../../../examples/hello.re");
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn server_gate_binds_multimodule_http_json_and_sqlite_authority() {
    let fixture = fixture();
    let first = run(&fixture);
    assert!(
        first.status.success(),
        "status={:?} stdout={} stderr={}",
        first.status,
        text(&first.stdout),
        text(&first.stderr)
    );
    let second = run(&fixture);
    assert!(
        second.status.success(),
        "status={:?} stdout={} stderr={}",
        second.status,
        text(&second.stdout),
        text(&second.stderr)
    );
    assert_eq!(first.stdout, second.stdout);
    assert_eq!(fs::read(&fixture.report).unwrap(), first.stdout);

    let output = text(&first.stdout);
    assert!(output.contains("re.native-project-server-gate@0.2.0"));
    assert!(output.contains("\"http_status\":200"));
    assert!(output.contains("\"route_id\":\"project-run\""));
    assert!(output.contains("\"json_schema\":\"re.native-project-server-response@0.1.0\""));
    assert!(output.contains("\"module_count\":2"));
    assert!(output.contains("\"transaction_affected_rows\":2"));
    assert!(output.contains(&format!(
        "\"sqlite_executable_digest\":\"sha256:{}\"",
        sha256_hex(&fs::read(&fixture.sqlite_executable).unwrap())
    )));
    assert!(!output.contains(fixture.root.to_str().unwrap()));
    cleanup(&fixture);
}

#[test]
fn server_gate_rejects_route_and_input_drift_before_report_write() {
    let fixture = fixture();
    fs::write(&fixture.report, b"sentinel\n").unwrap();
    let result = run_with_input(&fixture, "not-a-digest");
    assert_eq!(
        result.status.code(),
        Some(65),
        "stdout={} stderr={}",
        text(&result.stdout),
        text(&result.stderr)
    );
    assert!(
        text(&result.stdout).contains("native-vm-request-input-digest-invalid"),
        "stdout={} stderr={}",
        text(&result.stdout),
        text(&result.stderr)
    );
    assert_eq!(fs::read(&fixture.report).unwrap(), b"sentinel\n");
    cleanup(&fixture);
}

#[test]
fn server_gate_rejects_unavailable_sqlite_executable_before_report_write() {
    let fixture = fixture();
    fs::write(&fixture.report, b"sentinel\n").unwrap();
    let result = run_with_sqlite(&fixture, "/missing/revia-sqlite3", INPUT);
    assert_eq!(
        result.status.code(),
        Some(65),
        "stdout={} stderr={}",
        text(&result.stdout),
        text(&result.stderr)
    );
    assert!(
        text(&result.stdout).contains("native-project-server-gate-sqlite-unavailable"),
        "stdout={} stderr={}",
        text(&result.stdout),
        text(&result.stderr)
    );
    assert_eq!(fs::read(&fixture.report).unwrap(), b"sentinel\n");
    cleanup(&fixture);
}

struct Fixture {
    plan: PathBuf,
    report: PathBuf,
    database: PathBuf,
    sqlite_executable: PathBuf,
    root: PathBuf,
}

fn fixture() -> Fixture {
    let root = temp_root();
    fs::create_dir_all(root.join("modules")).unwrap();
    fs::write(root.join("modules/core.re"), SOURCE).unwrap();
    fs::write(root.join("modules/api.re"), SOURCE).unwrap();
    let source_digest = format!("sha256:{}", sha256_hex(SOURCE.as_bytes()));
    let core_interface = NativeInterface::new(
        "agent.native.core",
        vec![],
        vec![NativeExport::function("main", CONTRACT)],
    );
    let core_interface_digest = core_interface.digest().unwrap();
    let api_interface = NativeInterface::new(
        "agent.native.api",
        vec![NativeDependency::package(
            "core",
            core_interface_digest.clone(),
            "agent.native.core",
        )],
        vec![NativeExport::function("main", CONTRACT)],
    );
    let package = NativePackage::new(
        "agent.native",
        vec![
            NativeModule::new("agent.native.core", source_digest.clone(), core_interface),
            NativeModule::new("agent.native.api", source_digest.clone(), api_interface),
        ],
    );
    fs::write(
        root.join("project.json"),
        serialize_project_manifest(
            &[
                NativeProjectModule::new(
                    "agent.native.core",
                    "modules/core.re",
                    source_digest.clone(),
                ),
                NativeProjectModule::new("agent.native.api", "modules/api.re", source_digest),
            ],
            &package,
        )
        .unwrap(),
    )
    .unwrap();
    let plan = NativeProjectExecutionPlan::new(
        "agent.native.api",
        "main",
        vec![NativeProjectExecutionStep::new(
            "core",
            "agent.native.core",
            "main",
            core_interface_digest,
            CONTRACT,
        )],
    );
    let plan_path = root.with_file_name(format!(
        "{}-plan.json",
        root.file_name().unwrap().to_string_lossy()
    ));
    let report = root.with_file_name(format!(
        "{}-server-report.json",
        root.file_name().unwrap().to_string_lossy()
    ));
    let database = root.with_file_name(format!(
        "{}-server.db",
        root.file_name().unwrap().to_string_lossy()
    ));
    fs::write(&plan_path, serialize_project_execution_plan(&plan).unwrap()).unwrap();
    Fixture {
        plan: plan_path,
        report,
        database,
        sqlite_executable: std::env::var_os("REVIA_TEST_SQLITE")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/usr/bin/sqlite3")),
        root,
    }
}

fn run(fixture: &Fixture) -> std::process::Output {
    run_with_input(fixture, INPUT)
}

fn run_with_input(fixture: &Fixture, input: &str) -> std::process::Output {
    run_with_sqlite(fixture, &fixture.sqlite_executable.to_string_lossy(), input)
}

fn run_with_sqlite(
    fixture: &Fixture,
    sqlite_executable: &str,
    input: &str,
) -> std::process::Output {
    let binary_name = if cfg!(windows) { "revia.exe" } else { "revia" };
    let binary = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../target/release")
        .join(binary_name);
    let mut command = Command::new(binary);
    command
        .args([
            "project-server-gate",
            fixture.root.to_str().unwrap(),
            fixture.plan.to_str().unwrap(),
            PROFILE,
            TOOLCHAIN,
            input,
            sqlite_executable,
            fixture.database.to_str().unwrap(),
            fixture.report.to_str().unwrap(),
        ])
        .env_clear()
        .env("PATH", if cfg!(windows) { "" } else { "/usr/bin" });
    #[cfg(windows)]
    for key in [
        "SystemRoot",
        "WINDIR",
        "SystemDrive",
        "ComSpec",
        "TEMP",
        "TMP",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command.output().unwrap()
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn cleanup(fixture: &Fixture) {
    let _ = fs::remove_dir_all(&fixture.root);
    let _ = fs::remove_file(&fixture.plan);
    let _ = fs::remove_file(&fixture.report);
    let _ = fs::remove_file(&fixture.database);
}

fn temp_root() -> PathBuf {
    std::env::temp_dir().join(format!(
        "revia-wp299-cli-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ))
}
