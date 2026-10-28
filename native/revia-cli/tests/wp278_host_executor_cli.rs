use std::{
    fs,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

use revia_core::{
    bytecode::{serialize_bytecode_artifact, translate_graph},
    graph::{check_graph, parse_compact_graph},
};

const HELLO: &str = include_str!("../../../examples/hello.re");
const READ: &str = include_str!("../../../examples/read-encoding.re");
const INPUT: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

#[test]
fn native_execute_and_explicit_translate_run_share_real_host_stdout() {
    let root = temp_root("stdout");
    fs::create_dir_all(&root).unwrap();
    let source = root.join("hello.re");
    let artifact_path = root.join("hello.bytecode");
    fs::write(&source, HELLO).unwrap();

    let graph = check_graph(parse_compact_graph(HELLO, "hello.re").unwrap()).unwrap();
    let artifact = translate_graph(&graph).unwrap();
    fs::write(
        &artifact_path,
        serialize_bytecode_artifact(&artifact).unwrap(),
    )
    .unwrap();

    let execute = Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(["execute", source.to_str().unwrap(), INPUT])
        .output()
        .unwrap();
    let staged = Command::new(env!("CARGO_BIN_EXE_revia"))
        .args([
            "run",
            source.to_str().unwrap(),
            artifact_path.to_str().unwrap(),
            INPUT,
        ])
        .output()
        .unwrap();

    assert!(
        execute.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&execute.stdout),
        String::from_utf8_lossy(&execute.stderr),
    );
    assert_eq!(staged.stdout, execute.stdout);
    assert_eq!(staged.stderr, execute.stderr);
    let output = String::from_utf8(execute.stdout).unwrap();
    assert!(output.contains("\"program_stdout\":\"Hello, World!\\n\""));
    assert!(output.contains("\"host_profile\":\"re.native-server-host@0.1.0\""));
    assert!(!output.contains(root.to_str().unwrap()));
    assert!(execute.stderr.is_empty());

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn native_execute_reads_only_from_the_source_directory_sandbox() {
    let root = temp_root("read");
    fs::create_dir_all(&root).unwrap();
    let source = root.join("read.re");
    fs::write(&source, READ).unwrap();
    fs::write(root.join("input.txt"), "host-backed input").unwrap();

    let present = Command::new(env!("CARGO_BIN_EXE_revia"))
        .current_dir(std::env::temp_dir())
        .args(["execute", source.to_str().unwrap(), INPUT])
        .output()
        .unwrap();
    assert!(present.status.success());
    let present = String::from_utf8(present.stdout).unwrap();
    assert!(present.contains("\"code\":0"));
    assert!(present.contains("\"program_stdout\":\"\""));

    fs::remove_file(root.join("input.txt")).unwrap();
    let missing = Command::new(env!("CARGO_BIN_EXE_revia"))
        .current_dir(std::env::temp_dir())
        .args(["execute", source.to_str().unwrap(), INPUT])
        .output()
        .unwrap();
    assert!(missing.status.success());
    let missing = String::from_utf8(missing.stdout).unwrap();
    assert!(missing.contains("\"code\":2"));
    assert!(missing.contains("\"outcome\":\"err\""));
    assert!(missing.contains("\"program_stdout\":\"\""));

    fs::remove_dir_all(root).unwrap();
}

fn temp_root(label: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "revia-wp278-{label}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ))
}
