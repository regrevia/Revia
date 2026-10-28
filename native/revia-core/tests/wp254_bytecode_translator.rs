use revia_core::{
    bytecode::{
        BytecodeInstruction, NATIVE_BYTECODE_PROFILE, NATIVE_BYTECODE_RELEASE,
        NATIVE_BYTECODE_TRANSLATOR, bytecode_artifact_digest, load_bytecode_artifact,
        serialize_bytecode_artifact, translate_graph, verify_bytecode_artifact,
    },
    graph::{check_graph, graph_revision, parse_compact_graph},
};

const HELLO: &str = include_str!("../../../examples/hello.re");
const ARGS: &str = include_str!("../../../examples/args-check.re");
const READ_ENCODING: &str = include_str!("../../../examples/read-encoding.re");
const WRITE: &str = include_str!("../../../examples/write-check.re");

fn checked(source: &str, file: &str) -> revia_core::graph::Graph {
    check_graph(parse_compact_graph(source, file).unwrap()).unwrap()
}

#[test]
fn translator_is_deterministic_and_binds_graph_release_profile_and_identity() {
    for (source, file) in [
        (HELLO, "hello.re"),
        (ARGS, "args-check.re"),
        (READ_ENCODING, "read-encoding.re"),
        (WRITE, "write-check.re"),
    ] {
        let graph = checked(source, file);
        let first = translate_graph(&graph).unwrap();
        let second = translate_graph(&graph).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.graph_revision, graph_revision(&graph).unwrap());
        assert_eq!(first.canonical_graph_sha256, first.graph_revision);
        assert_eq!(first.profile, NATIVE_BYTECODE_PROFILE);
        assert_eq!(first.release, NATIVE_BYTECODE_RELEASE);
        assert_eq!(first.translator, NATIVE_BYTECODE_TRANSLATOR);
        assert_eq!(
            first.artifact_digest,
            bytecode_artifact_digest(&first).unwrap()
        );

        let bytes = serialize_bytecode_artifact(&first).unwrap();
        let loaded = load_bytecode_artifact(&bytes).unwrap();
        assert_eq!(loaded, first);
        assert_eq!(serialize_bytecode_artifact(&loaded).unwrap(), bytes);
        assert_eq!(verify_bytecode_artifact(&graph, &bytes).unwrap(), first);
    }
}

#[test]
fn translator_emits_the_minimal_capability_result_and_return_slice() {
    let artifact = translate_graph(&checked(HELLO, "hello.re")).unwrap();
    assert_eq!(artifact.instructions.len(), 4);
    assert!(matches!(
        &artifact.instructions[0],
        BytecodeInstruction::InvokeCapability {
            destination: 0,
            instance,
            member,
            ..
        } if instance == "@stdout" && member == "write"
    ));
    assert!(matches!(
        artifact.instructions[1],
        BytecodeInstruction::BranchResult {
            source: 0,
            ok: 2,
            err: 3
        }
    ));
    assert!(matches!(
        artifact.instructions[2],
        BytecodeInstruction::ReturnStatus { .. }
    ));
    assert!(matches!(
        artifact.instructions[3],
        BytecodeInstruction::ReturnStatus { .. }
    ));
}

#[test]
fn loader_rejects_opcode_register_jump_literal_and_authority_drift() {
    let graph = checked(HELLO, "hello.re");
    let bytes = serialize_bytecode_artifact(&translate_graph(&graph).unwrap()).unwrap();

    let opcode = bytes.replacen("invoke-capability", "invoke-unknown", 1);
    assert_eq!(
        load_bytecode_artifact(&opcode).unwrap_err().code,
        "bytecode-opcode-invalid"
    );

    let register = bytes.replacen("destination=0", "destination=1", 1);
    assert_eq!(
        load_bytecode_artifact(&register).unwrap_err().code,
        "bytecode-register-invalid"
    );

    let jump = bytes.replacen("ok=2 err=3", "ok=2 err=2", 1);
    assert_eq!(
        load_bytecode_artifact(&jump).unwrap_err().code,
        "bytecode-jump-invalid"
    );

    let literal = bytes.replacen(" text.utf8 ", " unknown.type ", 1);
    assert_eq!(
        load_bytecode_artifact(&literal).unwrap_err().code,
        "bytecode-literal-type-invalid"
    );

    let authority = bytes.replacen(NATIVE_BYTECODE_PROFILE, "re.native-bytecode@9.9.9", 1);
    assert_eq!(
        load_bytecode_artifact(&authority).unwrap_err().code,
        "bytecode-profile-mismatch"
    );

    let noncanonical = format!("{bytes}\n");
    assert_eq!(
        load_bytecode_artifact(&noncanonical).unwrap_err().code,
        "bytecode-non-canonical-source"
    );
}

#[test]
fn verifier_rejects_internally_resigned_literal_argument_and_graph_drift() {
    let graph = checked(HELLO, "hello.re");
    let mut literal_drift = translate_graph(&graph).unwrap();
    literal_drift.literals[0].value = "Goodbye\n".to_owned();
    literal_drift.artifact_digest = bytecode_artifact_digest(&literal_drift).unwrap();
    let bytes = serialize_bytecode_artifact(&literal_drift).unwrap();
    assert_eq!(
        verify_bytecode_artifact(&graph, &bytes).unwrap_err().code,
        "bytecode-graph-artifact-mismatch"
    );

    let mut argument_drift = translate_graph(&graph).unwrap();
    if let BytecodeInstruction::InvokeCapability { arguments, .. } =
        &mut argument_drift.instructions[0]
    {
        arguments[0].name = "path".to_owned();
    }
    argument_drift.artifact_digest = bytecode_artifact_digest(&argument_drift).unwrap();
    let bytes = serialize_bytecode_artifact(&argument_drift).unwrap();
    assert_eq!(
        verify_bytecode_artifact(&graph, &bytes).unwrap_err().code,
        "bytecode-graph-artifact-mismatch"
    );

    let other_graph = checked(ARGS, "args-check.re");
    let bytes = serialize_bytecode_artifact(&translate_graph(&graph).unwrap()).unwrap();
    assert_eq!(
        verify_bytecode_artifact(&other_graph, &bytes)
            .unwrap_err()
            .code,
        "bytecode-graph-revision-mismatch"
    );
}

#[test]
fn translator_rejects_extra_functions_statements_and_unsupported_control() {
    let mut graph = checked(HELLO, "hello.re");
    let duplicate = graph.functions[0].clone();
    graph.functions.push(duplicate);
    assert_eq!(
        translate_graph(&graph).unwrap_err().code,
        "bytecode-function-shape-unsupported"
    );

    let mut graph = checked(HELLO, "hello.re");
    let duplicate_statement = graph.functions[0].statements[0].clone();
    graph.functions[0].statements.push(duplicate_statement);
    assert_eq!(
        translate_graph(&graph).unwrap_err().code,
        "bytecode-statement-shape-unsupported"
    );

    let mut graph = checked(HELLO, "hello.re");
    if let revia_core::graph::Statement::Return { value, .. } =
        &mut graph.functions[0].statements[1]
    {
        value.branches.pop();
    }
    assert_eq!(
        translate_graph(&graph).unwrap_err().code,
        "bytecode-control-shape-unsupported"
    );
}

#[test]
fn bytecode_loader_survives_one_hundred_thousand_deterministic_mutations() {
    let artifact =
        serialize_bytecode_artifact(&translate_graph(&checked(HELLO, "hello.re")).unwrap())
            .unwrap();
    let original = artifact.as_bytes();
    let mut state = 0x254b_17cdu64;
    for iteration in 0..100_000usize {
        state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        let index = (state as usize) % original.len();
        let mut mutated = original.to_vec();
        let replacement = 0x20 + (((state >> 32) as u8).wrapping_add(iteration as u8) % 0x5f);
        mutated[index] = if replacement == original[index] {
            if replacement == 0x7e {
                0x20
            } else {
                replacement + 1
            }
        } else {
            replacement
        };
        if let Ok(source) = std::str::from_utf8(&mutated) {
            assert!(
                load_bytecode_artifact(source).is_err(),
                "mutation {iteration} unexpectedly accepted"
            );
        }
    }
}
