use revia_core::{
    bytecode::{serialize_bytecode_artifact, translate_graph},
    graph::{check_graph, parse_compact_graph},
    runtime_authority::{
        RUNTIME_LOAD_AUTHORITY_SCHEMA, build_runtime_load_authority_pin,
        serialize_runtime_load_authority_pin, verify_runtime_load_authority,
    },
    runtime_bundle::{build_runtime_bundle, serialize_runtime_bundle},
};

const SOURCE: &str = include_str!("../../../examples/hello.re");
const INPUT_DIGEST: &str =
    "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const RUNTIME: &str = "re.native-vm@0.1.0";
const COMMAND: &str = "runtime-run";

fn bundle_source() -> String {
    let graph = check_graph(parse_compact_graph(SOURCE, "hello.re").unwrap()).unwrap();
    let artifact = translate_graph(&graph).unwrap();
    let artifact_source = serialize_bytecode_artifact(&artifact).unwrap();
    serialize_runtime_bundle(&build_runtime_bundle(&graph, &artifact_source).unwrap()).unwrap()
}

#[test]
fn runtime_load_authority_pin_binds_reviewed_and_loaded_bundle() {
    let bundle = bundle_source();
    let pin = build_runtime_load_authority_pin(&bundle, RUNTIME, COMMAND, INPUT_DIGEST).unwrap();
    let serialized = serialize_runtime_load_authority_pin(&pin).unwrap();
    assert_eq!(pin.schema, RUNTIME_LOAD_AUTHORITY_SCHEMA);
    assert_eq!(
        verify_runtime_load_authority(
            &serialized,
            bundle.as_bytes(),
            RUNTIME,
            COMMAND,
            INPUT_DIGEST
        )
        .unwrap(),
        pin
    );
}

#[test]
fn runtime_load_authority_rejects_loaded_byte_drift_and_runtime_input_drift() {
    let bundle = bundle_source();
    let pin = build_runtime_load_authority_pin(&bundle, RUNTIME, COMMAND, INPUT_DIGEST).unwrap();
    let serialized = serialize_runtime_load_authority_pin(&pin).unwrap();
    let mut changed = bundle.as_bytes().to_vec();
    let changed_index = changed
        .iter()
        .position(|byte| *byte == b'0')
        .expect("bundle contains a digest zero");
    changed[changed_index] = b'1';
    assert_eq!(
        verify_runtime_load_authority(&serialized, &changed, RUNTIME, COMMAND, INPUT_DIGEST)
            .unwrap_err()
            .code,
        "DRIFTED"
    );
    assert_eq!(
        verify_runtime_load_authority(
            &serialized,
            bundle.as_bytes(),
            "re.native-vm@drifted",
            COMMAND,
            INPUT_DIGEST,
        )
        .unwrap_err()
        .code,
        "DRIFTED"
    );
    assert_eq!(
        verify_runtime_load_authority(
            &serialized,
            bundle.as_bytes(),
            RUNTIME,
            COMMAND,
            "sha256:bad",
        )
        .unwrap_err()
        .code,
        "DRIFTED"
    );
}

#[test]
fn runtime_load_authority_rejects_algorithm_and_canonicalization_downgrade() {
    let bundle = bundle_source();
    let pin = build_runtime_load_authority_pin(&bundle, RUNTIME, COMMAND, INPUT_DIGEST).unwrap();
    let mut algorithm_drift = pin.clone();
    algorithm_drift.hash_algorithm = "none".to_owned();
    assert_eq!(
        serialize_runtime_load_authority_pin(&algorithm_drift)
            .unwrap_err()
            .code,
        "native-runtime-load-authority-field-invalid"
    );
    let mut canonicalization_drift = pin;
    canonicalization_drift.canonicalization = "json".to_owned();
    assert_eq!(
        serialize_runtime_load_authority_pin(&canonicalization_drift)
            .unwrap_err()
            .code,
        "native-runtime-load-authority-field-invalid"
    );
}
