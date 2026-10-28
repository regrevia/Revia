use revia_core::{
    bytecode::{serialize_bytecode_artifact, translate_graph},
    graph::{check_graph, load_canonical_graph, parse_compact_graph, serialize_canonical_graph},
    runtime_bundle::{
        build_runtime_bundle, parse_runtime_bundle, serialize_runtime_bundle, verify_runtime_bundle,
    },
};

const SOURCE: &str = include_str!("../../../examples/hello.re");

fn bundle_source() -> String {
    let graph = check_graph(parse_compact_graph(SOURCE, "hello.re").unwrap()).unwrap();
    let artifact = translate_graph(&graph).unwrap();
    let artifact_source = serialize_bytecode_artifact(&artifact).unwrap();
    serialize_runtime_bundle(&build_runtime_bundle(&graph, &artifact_source).unwrap()).unwrap()
}

#[test]
fn compact_and_canonical_sources_produce_the_same_bundle_bytes() {
    let compact_graph = check_graph(parse_compact_graph(SOURCE, "hello.re").unwrap()).unwrap();
    let canonical_source = serialize_canonical_graph(&compact_graph).unwrap();
    let canonical_graph = load_canonical_graph(&canonical_source).unwrap();
    let compact_artifact =
        serialize_bytecode_artifact(&translate_graph(&compact_graph).unwrap()).unwrap();
    let canonical_artifact =
        serialize_bytecode_artifact(&translate_graph(&canonical_graph).unwrap()).unwrap();

    let compact_bundle =
        serialize_runtime_bundle(&build_runtime_bundle(&compact_graph, &compact_artifact).unwrap())
            .unwrap();
    let canonical_bundle = serialize_runtime_bundle(
        &build_runtime_bundle(&canonical_graph, &canonical_artifact).unwrap(),
    )
    .unwrap();

    assert_eq!(compact_bundle, canonical_bundle);
}

#[test]
fn runtime_bundle_is_canonical_and_rebuildable_from_compact_source() {
    let source = bundle_source();
    let bundle = parse_runtime_bundle(&source).unwrap();
    assert_eq!(serialize_runtime_bundle(&bundle).unwrap(), source);
    assert_eq!(
        verify_runtime_bundle(&source).unwrap(),
        bundle,
        "offline verification must rebuild graph and artifact authority"
    );
    assert!(bundle.canonical_source.starts_with("re 0.1 canonical\n"));
    assert!(!source.contains("hello.re"));
    assert!(!source.contains("elapsed_ns"));
}

#[test]
fn runtime_bundle_rejects_synchronized_digest_and_payload_drift() {
    let source = bundle_source();
    let mut bundle = parse_runtime_bundle(&source).unwrap();
    bundle.artifact.push_str("tampered");
    assert!(serialize_runtime_bundle(&bundle).is_err());

    let mut resigned = parse_runtime_bundle(&source).unwrap();
    resigned.bundle_digest = resigned.bundle_digest.clone();
    resigned.source_digest =
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned();
    assert!(verify_runtime_bundle(&serialize_runtime_bundle(&resigned).unwrap()).is_err());
}
