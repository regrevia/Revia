use revia_core::cross_language::{
    CrossLanguageBackendResult, CrossLanguageInvocation, PendingBackend,
    build_cross_language_matrix, parse_backend_result, parse_cross_language_matrix,
    serialize_backend_result, serialize_cross_language_matrix,
};

const GRAPH: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const INPUT: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TRANSCRIPT: &str = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const TOOLCHAIN: &str = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const RESULT: &str = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const RECEIPT: &str = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

fn backend(name: &str, semantic: &str) -> CrossLanguageBackendResult {
    CrossLanguageBackendResult::measured(
        name,
        GRAPH,
        INPUT,
        TRANSCRIPT,
        TOOLCHAIN,
        RESULT,
        RECEIPT,
        0,
        "process.status",
        vec![CrossLanguageInvocation::new(
            "@stdout",
            "write",
            "aaaaaadaaaaaaaaaaaaaaaaaaa",
            "ok",
        )],
        semantic,
    )
}

#[test]
fn cross_language_backend_and_matrix_round_trip_are_canonical() {
    let native = backend(
        "native",
        "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    );
    let node = backend(
        "node",
        "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    );
    let matrix = build_cross_language_matrix(
        "canonical-hello",
        GRAPH,
        INPUT,
        TRANSCRIPT,
        vec![native, node],
        vec![
            PendingBackend::new("go", "not-measured"),
            PendingBackend::new("jvm", "not-measured"),
        ],
    )
    .unwrap();
    let backend_source = serialize_backend_result(&matrix.measured[0]).unwrap();
    assert_eq!(
        serialize_backend_result(&parse_backend_result(&backend_source).unwrap()).unwrap(),
        backend_source
    );
    let source = serialize_cross_language_matrix(&matrix).unwrap();
    assert_eq!(
        serialize_cross_language_matrix(&parse_cross_language_matrix(&source).unwrap()).unwrap(),
        source
    );
    assert_eq!(matrix.status, "semantic-equivalent");
}

#[test]
fn cross_language_matrix_rejects_backend_and_authority_drift() {
    let native = backend(
        "native",
        "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    );
    let node = backend(
        "node",
        "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    );
    let matrix = build_cross_language_matrix(
        "canonical-hello",
        GRAPH,
        INPUT,
        TRANSCRIPT,
        vec![native, node],
        vec![
            PendingBackend::new("go", "not-measured"),
            PendingBackend::new("jvm", "not-measured"),
        ],
    )
    .unwrap();
    let source = serialize_cross_language_matrix(&matrix).unwrap();
    for bad in [
        source.replace("\"backend\":\"node\"", "\"backend\":\"native\""),
        source.replace(
            "\"status\":\"semantic-equivalent\"",
            "\"status\":\"semantic-mismatch\"",
        ),
        source.replace(TRANSCRIPT, INPUT),
    ] {
        assert!(parse_cross_language_matrix(&bad).is_err());
    }
}

#[test]
fn cross_language_matrix_rejects_mismatch_and_fabricated_measured_backend() {
    let native = backend(
        "native",
        "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    );
    let mut node = backend(
        "node",
        "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    );
    node.semantic_digest =
        "sha256:2222222222222222222222222222222222222222222222222222222222222222".to_owned();
    assert!(
        build_cross_language_matrix(
            "canonical-hello",
            GRAPH,
            INPUT,
            TRANSCRIPT,
            vec![native.clone(), node.clone()],
            vec![
                PendingBackend::new("go", "not-measured"),
                PendingBackend::new("jvm", "not-measured"),
            ],
        )
        .is_err()
    );
    node.status = "pending".to_owned();
    assert!(
        build_cross_language_matrix(
            "canonical-hello",
            GRAPH,
            INPUT,
            TRANSCRIPT,
            vec![native, node],
            vec![
                PendingBackend::new("go", "not-measured"),
                PendingBackend::new("jvm", "not-measured"),
            ],
        )
        .is_err()
    );
}

#[test]
fn cross_language_backend_rejects_noncanonical_and_unknown_fields() {
    let backend = backend(
        "native",
        "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    );
    let source = serialize_backend_result(&backend).unwrap();
    assert!(parse_backend_result(&source.replace("\"backend\":", " \"backend\":")).is_err());
    assert!(
        parse_backend_result(&source.replace(
            "\"status\":\"measured\"",
            "\"status\":\"measured\",\"unexpected\":true",
        ))
        .is_err()
    );
}
