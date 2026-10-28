use revia_core::graph::{
    check_graph, graph_revision, load_canonical_graph, parse_compact_graph, review_manifest,
    serialize_canonical_graph,
};

const HELLO: &str = include_str!("../../../examples/hello.re");
const READ_ENCODING: &str = include_str!("../../../examples/read-encoding.re");

#[test]
fn compact_graph_checks_and_round_trips_through_two_canonical_generations() {
    let graph = check_graph(parse_compact_graph(HELLO, "examples/hello.re").unwrap()).unwrap();
    let canonical = serialize_canonical_graph(&graph).unwrap();
    assert!(canonical.starts_with("re 0.1 canonical\n"));
    assert!(canonical.contains("cap %uaaaaaaa: uid(\"aaaaaaaaaaaaaaaaaaaaaaaaaa\")"));

    let first = load_canonical_graph(&canonical).unwrap();
    let second = load_canonical_graph(&serialize_canonical_graph(&first).unwrap()).unwrap();
    assert_eq!(serialize_canonical_graph(&first).unwrap(), canonical);
    assert_eq!(serialize_canonical_graph(&second).unwrap(), canonical);
    assert_eq!(
        graph_revision(&first).unwrap(),
        graph_revision(&second).unwrap()
    );
}

#[test]
fn canonical_serializer_is_order_independent_but_uid_stable() {
    let graph =
        check_graph(parse_compact_graph(READ_ENCODING, "read-encoding.re").unwrap()).unwrap();
    let mut reordered = graph.clone();
    reordered.capabilities.reverse();
    reordered.functions[0].literals.reverse();
    reordered.functions[0].statements.reverse();
    let original = serialize_canonical_graph(&graph).unwrap();
    assert_eq!(serialize_canonical_graph(&reordered).unwrap(), original);
    assert_eq!(
        graph_revision(&graph).unwrap(),
        graph_revision(&reordered).unwrap()
    );
}

#[test]
fn checker_rejects_schema_member_argument_and_type_drift() {
    let mut graph = parse_compact_graph(HELLO, "hello.re").unwrap();
    graph.capabilities[0].reference = "process.args@0.1.0".to_owned();
    let error = check_graph(graph).unwrap_err();
    assert_eq!(error.code, "call-schema-reference-mismatch");

    let mut graph = parse_compact_graph(HELLO, "hello.re").unwrap();
    if let revia_core::graph::Statement::Let { value, .. } = &mut graph.functions[0].statements[0] {
        value.arguments[0].name = "path".to_owned();
    }
    let error = check_graph(graph).unwrap_err();
    assert_eq!(error.code, "unknown-argument");

    let mut graph = parse_compact_graph(HELLO, "hello.re").unwrap();
    graph.functions[0].literals[0].type_name = "int".to_owned();
    let error = check_graph(graph).unwrap_err();
    assert_eq!(error.code, "literal-type-mismatch");

    let mut graph = parse_compact_graph(HELLO, "hello.re").unwrap();
    graph.capabilities[0].reference = "unknown.schema@9.9.9".to_owned();
    let error = check_graph(graph).unwrap_err();
    assert_eq!(error.code, "unknown-schema-reference");
}

#[test]
fn canonical_loader_fails_closed_on_noncanonical_and_identity_drift() {
    let graph = check_graph(parse_compact_graph(HELLO, "hello.re").unwrap()).unwrap();
    let canonical = serialize_canonical_graph(&graph).unwrap();

    let noncanonical = canonical.replace("\nunit ", "\n\nunit ");
    assert_eq!(
        load_canonical_graph(&noncanonical).unwrap_err().code,
        "unexpected-canonical-line"
    );

    let spoofed = canonical.replace("@stdout.write", "@stdout.unknown");
    assert_eq!(
        load_canonical_graph(&spoofed).unwrap_err().code,
        "unknown-capability-member"
    );

    let unknown_schema = canonical.replace("process.stdout@0.1.0", "unknown.schema@9.9.9");
    assert_eq!(
        load_canonical_graph(&unknown_schema).unwrap_err().code,
        "unknown-schema-reference"
    );

    let collision = canonical.replacen(
        "%uaaaaaad: uid(\"aaaaaadaaaaaaaaaaaaaaaaaaa\")",
        "%uaaaaaaa: uid(\"aaaaaaaaaaaaaaaaaaaaaaaaaa\")",
        1,
    );
    assert_eq!(
        load_canonical_graph(&collision).unwrap_err().code,
        "uid-collision"
    );

    let label_drift = canonical.replacen("%uaaaaaaa: uid", "%uaaaaaab: uid", 1);
    assert_eq!(
        load_canonical_graph(&label_drift).unwrap_err().code,
        "label-uid-mismatch"
    );
}

#[test]
fn review_manifest_is_revision_bound_and_distinguishes_reachable_from_executed() {
    let graph = check_graph(parse_compact_graph(HELLO, "hello.re").unwrap()).unwrap();
    let manifest = review_manifest(&graph).unwrap();
    assert_eq!(manifest.schema, "re.native-review-manifest@0.1.0");
    assert_eq!(manifest.graph_revision, graph_revision(&graph).unwrap());
    assert!(manifest.reachable.len() >= manifest.executed.len());
    assert!(manifest.reachable.iter().any(|entry| entry == "return"));
}
