use revia_core::{
    bytecode::{serialize_bytecode_artifact, translate_graph},
    graph::{check_graph, parse_compact_graph},
    runtime_authority::build_runtime_load_authority_pin,
    runtime_bundle::{build_runtime_bundle, serialize_runtime_bundle},
    runtime_receipt::{
        RUNTIME_LOAD_RECEIPT_SCHEMA, build_runtime_load_receipt, serialize_runtime_load_receipt,
        verify_runtime_load_receipt,
    },
};

const SOURCE: &str = include_str!("../../../examples/hello.re");
const INPUT_DIGEST: &str =
    "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

fn bundle_source() -> String {
    let graph = check_graph(parse_compact_graph(SOURCE, "hello.re").unwrap()).unwrap();
    let artifact = translate_graph(&graph).unwrap();
    let artifact_source = serialize_bytecode_artifact(&artifact).unwrap();
    serialize_runtime_bundle(&build_runtime_bundle(&graph, &artifact_source).unwrap()).unwrap()
}

#[test]
fn runtime_load_receipt_binds_pin_result_and_stdout_bytes() {
    let bundle = bundle_source();
    let pin = build_runtime_load_authority_pin(
        &bundle,
        "re.native-vm@0.1.0",
        "runtime-run",
        INPUT_DIGEST,
    )
    .unwrap();
    let result = format!(
        "{{\"artifact_digest\":\"sha256:{}\",\"graph_revision\":\"{}\",\"input_digest\":\"{}\",\"ok\":true,\"receipt_digest\":\"sha256:{}\"}}\n",
        "a".repeat(64),
        pin.graph_revision,
        INPUT_DIGEST,
        "a".repeat(64)
    );
    let stdout = b"Hello, World!\n";
    let receipt = build_runtime_load_receipt(&pin, result.as_bytes(), stdout).unwrap();
    let serialized = serialize_runtime_load_receipt(&receipt).unwrap();
    assert_eq!(receipt.schema, RUNTIME_LOAD_RECEIPT_SCHEMA);
    assert_eq!(
        verify_runtime_load_receipt(&serialized, &pin, result.as_bytes(), stdout).unwrap(),
        receipt
    );

    let mut changed_result = result.clone().into_bytes();
    let changed_index = changed_result
        .iter()
        .rposition(|byte| *byte == b'a')
        .expect("result contains a digest byte");
    changed_result[changed_index] = b'b';
    assert_eq!(
        verify_runtime_load_receipt(&serialized, &pin, &changed_result, stdout)
            .unwrap_err()
            .code,
        "DRIFTED"
    );

    let wrong_graph = result.replace(
        &pin.graph_revision,
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    assert_eq!(
        build_runtime_load_receipt(&pin, wrong_graph.as_bytes(), stdout)
            .unwrap_err()
            .code,
        "DRIFTED"
    );
}
