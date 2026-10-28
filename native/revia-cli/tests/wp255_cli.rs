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

#[test]
fn native_cli_run_executes_verified_artifact_without_node() {
    let graph = check_graph(parse_compact_graph(HELLO, "hello.re").unwrap()).unwrap();
    let artifact = translate_graph(&graph).unwrap();
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("revia-wp255-{stamp}"));
    fs::create_dir_all(&root).unwrap();
    let graph_path = root.join("hello.re");
    let artifact_path = root.join("hello.bytecode");
    fs::write(&graph_path, HELLO).unwrap();
    fs::write(
        &artifact_path,
        serialize_bytecode_artifact(&artifact).unwrap(),
    )
    .unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_revia"))
        .args([
            "run",
            graph_path.to_str().unwrap(),
            artifact_path.to_str().unwrap(),
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ])
        .output()
        .unwrap();
    fs::remove_dir_all(&root).unwrap();

    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.contains("\"ok\":true"));
    assert!(stdout.contains("\"executor\":\"re.native-vm@0.1.0\""));
    assert!(stdout.contains("\"code\":0"));
}
