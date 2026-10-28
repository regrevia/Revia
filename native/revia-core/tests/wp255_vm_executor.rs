use std::collections::BTreeMap;

use revia_core::{
    bytecode::{serialize_bytecode_artifact, translate_graph},
    graph::{check_graph, graph_revision, parse_compact_graph},
    vm::{
        CapabilityBridge, CapabilityResponse, NATIVE_VM_EXECUTOR, NATIVE_VM_RECEIPT_SCHEMA,
        NATIVE_VM_RESULT_SCHEMA, VmLimits, VmRequest, VmValue, execute_bytecode,
    },
};

const HELLO: &str = include_str!("../../../examples/hello.re");
const ARGS: &str = include_str!("../../../examples/args-check.re");
const READ_ENCODING: &str = include_str!("../../../examples/read-encoding.re");
const WRITE: &str = include_str!("../../../examples/write-check.re");

fn checked(source: &str, file: &str) -> revia_core::graph::Graph {
    check_graph(parse_compact_graph(source, file).unwrap()).unwrap()
}

#[derive(Default)]
struct StdoutBridge {
    calls: Vec<(String, String, BTreeMap<String, VmValue>)>,
}

impl CapabilityBridge for StdoutBridge {
    fn invoke(
        &mut self,
        instance: &str,
        member: &str,
        arguments: &BTreeMap<String, VmValue>,
        _invocation_id: &str,
    ) -> Result<CapabilityResponse, String> {
        self.calls
            .push((instance.to_owned(), member.to_owned(), arguments.clone()));
        Ok(CapabilityResponse::ok(VmValue::Unit))
    }
}

struct OutcomeBridge {
    outcome: CapabilityResponse,
}

impl CapabilityBridge for OutcomeBridge {
    fn invoke(
        &mut self,
        _instance: &str,
        _member: &str,
        _arguments: &BTreeMap<String, VmValue>,
        _invocation_id: &str,
    ) -> Result<CapabilityResponse, String> {
        Ok(self.outcome.clone())
    }
}

fn request(
    graph: &revia_core::graph::Graph,
    artifact: &revia_core::bytecode::BytecodeArtifact,
) -> VmRequest {
    VmRequest::new(
        graph_revision(graph).unwrap(),
        artifact.artifact_digest.clone(),
        artifact.profile.clone(),
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    )
}

#[test]
fn native_vm_executes_capability_branch_and_emits_deterministic_receipt() {
    let graph = checked(HELLO, "hello.re");
    let artifact = translate_graph(&graph).unwrap();
    let source = serialize_bytecode_artifact(&artifact).unwrap();
    let request = request(&graph, &artifact);

    let mut first_bridge = StdoutBridge::default();
    let first = execute_bytecode(
        &graph,
        &source,
        &request,
        &mut first_bridge,
        VmLimits::default(),
    )
    .unwrap();
    let mut second_bridge = StdoutBridge::default();
    let second = execute_bytecode(
        &graph,
        &source,
        &request,
        &mut second_bridge,
        VmLimits::default(),
    )
    .unwrap();

    assert_eq!(first, second);
    assert_eq!(first.schema, NATIVE_VM_RESULT_SCHEMA);
    assert_eq!(first.executor, NATIVE_VM_EXECUTOR);
    assert_eq!(first.receipt.schema, NATIVE_VM_RECEIPT_SCHEMA);
    assert_eq!(first.outcome.code, 0);
    assert_eq!(first.invocations[0].outcome, "ok");
    assert_eq!(first.trace.len(), 3);
    assert_eq!(first_bridge.calls.len(), 1);
}

#[test]
fn native_vm_rejects_request_authority_drift_before_bridge_effect() {
    let graph = checked(HELLO, "hello.re");
    let artifact = translate_graph(&graph).unwrap();
    let source = serialize_bytecode_artifact(&artifact).unwrap();
    let mut request = request(&graph, &artifact);
    request.artifact_digest =
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_owned();
    let mut bridge = StdoutBridge::default();

    let error =
        execute_bytecode(&graph, &source, &request, &mut bridge, VmLimits::default()).unwrap_err();

    assert_eq!(error.code, "native-vm-request-artifact-mismatch");
    assert!(bridge.calls.is_empty());
}

#[test]
fn native_vm_fails_closed_on_step_and_trace_budget() {
    let graph = checked(HELLO, "hello.re");
    let artifact = translate_graph(&graph).unwrap();
    let source = serialize_bytecode_artifact(&artifact).unwrap();
    let request = request(&graph, &artifact);
    let mut bridge = StdoutBridge::default();

    let limits = VmLimits {
        max_steps: 2,
        ..VmLimits::default()
    };
    let error = execute_bytecode(&graph, &source, &request, &mut bridge, limits).unwrap_err();
    assert_eq!(error.code, "native-vm-step-limit-exceeded");

    let limits = VmLimits {
        max_trace_entries: 2,
        ..VmLimits::default()
    };
    let error = execute_bytecode(&graph, &source, &request, &mut bridge, limits).unwrap_err();
    assert_eq!(error.code, "native-vm-trace-limit-exceeded");

    let limits = VmLimits {
        max_allocations: 0,
        ..VmLimits::default()
    };
    let mut allocation_bridge = StdoutBridge::default();
    assert_eq!(
        execute_bytecode(&graph, &source, &request, &mut allocation_bridge, limits)
            .unwrap_err()
            .code,
        "native-vm-allocation-limit-exceeded"
    );
    assert!(allocation_bridge.calls.is_empty());
}

#[test]
fn native_vm_matches_the_nine_case_execution_slice_without_expected_outcome_input() {
    let cases = [
        (HELLO, "hello.re", true, 0),
        (HELLO, "hello.re", false, 1),
        (ARGS, "args-check.re", true, 0),
        (ARGS, "args-check.re", false, 2),
        (READ_ENCODING, "read-encoding.re", true, 0),
        (READ_ENCODING, "read-encoding.re", false, 2),
        (WRITE, "write-check.re", true, 0),
        (WRITE, "write-check.re", false, 2),
        (HELLO, "hello-replay.re", true, 0),
    ];
    for (source, file, success, expected_code) in cases {
        let graph = checked(source, file);
        let artifact = translate_graph(&graph).unwrap();
        let bytes = serialize_bytecode_artifact(&artifact).unwrap();
        let request = request(&graph, &artifact);
        let response = if success {
            CapabilityResponse::ok(VmValue::Unit)
        } else {
            CapabilityResponse::err(VmValue::Unit)
        };
        let mut bridge = OutcomeBridge { outcome: response };
        let result =
            execute_bytecode(&graph, &bytes, &request, &mut bridge, VmLimits::default()).unwrap();
        let mut replay_bridge = OutcomeBridge {
            outcome: if success {
                CapabilityResponse::ok(VmValue::Unit)
            } else {
                CapabilityResponse::err(VmValue::Unit)
            },
        };
        let replay = execute_bytecode(
            &graph,
            &bytes,
            &request,
            &mut replay_bridge,
            VmLimits::default(),
        )
        .unwrap();
        assert_eq!(
            result.outcome.code, expected_code,
            "{file} success={success}"
        );
        assert_eq!(
            result.invocations[0].outcome,
            if success { "ok" } else { "err" },
            "{file} success={success}"
        );
        assert_eq!(result, replay, "{file} success={success}");
    }
}

#[test]
fn native_vm_rejects_invalid_bridge_outcomes_and_bridge_faults() {
    let graph = checked(HELLO, "hello.re");
    let artifact = translate_graph(&graph).unwrap();
    let bytes = serialize_bytecode_artifact(&artifact).unwrap();
    let request = request(&graph, &artifact);

    let mut invalid = OutcomeBridge {
        outcome: CapabilityResponse::Value {
            variant: "maybe".to_owned(),
            payload: VmValue::Unit,
        },
    };
    assert_eq!(
        execute_bytecode(&graph, &bytes, &request, &mut invalid, VmLimits::default(),)
            .unwrap_err()
            .code,
        "native-vm-capability-outcome-invalid"
    );

    let mut failed = OutcomeBridge {
        outcome: CapabilityResponse::host_fault("stdout-unavailable"),
    };
    assert_eq!(
        execute_bytecode(&graph, &bytes, &request, &mut failed, VmLimits::default(),)
            .unwrap_err()
            .code,
        "native-vm-capability-failed"
    );
}

#[test]
fn native_vm_artifact_mutations_never_reach_the_capability_bridge() {
    let graph = checked(HELLO, "hello.re");
    let artifact = translate_graph(&graph).unwrap();
    let source = serialize_bytecode_artifact(&artifact).unwrap();
    let original = source.as_bytes();
    let mut state = 0x255a_91efu64;
    for iteration in 0..10_000usize {
        state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        let index = (state as usize) % original.len();
        let replacement = 0x20 + (((state >> 32) as u8).wrapping_add(iteration as u8) % 0x5f);
        let mut mutated = original.to_vec();
        mutated[index] = if replacement == original[index] {
            if replacement == 0x7e {
                0x20
            } else {
                replacement + 1
            }
        } else {
            replacement
        };
        let mut bridge = StdoutBridge::default();
        if let Ok(mutated_source) = std::str::from_utf8(&mutated) {
            assert!(
                execute_bytecode(
                    &graph,
                    mutated_source,
                    &request(&graph, &artifact),
                    &mut bridge,
                    VmLimits::default(),
                )
                .is_err(),
                "mutation {iteration} unexpectedly executed"
            );
        }
        assert!(
            bridge.calls.is_empty(),
            "mutation {iteration} reached bridge"
        );
    }
}
