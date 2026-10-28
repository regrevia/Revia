use std::collections::BTreeMap;

use revia_core::{
    bytecode::{serialize_bytecode_artifact, translate_graph},
    graph::{check_graph, graph_revision, parse_compact_graph},
    minimal_std::{
        HostAdapter, HostBackedBridge, HostEnvironment, HostOutcome, HostRequest, MemoryHost,
        StdError,
    },
    vm::{VmLimits, VmRequest, execute_bytecode},
};

const HELLO: &str = include_str!("../../../examples/hello.re");
const READ: &str = include_str!("../../../examples/read-encoding.re");

const INPUT_DIGEST: &str =
    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn checked(source: &str, file: &str) -> revia_core::graph::Graph {
    check_graph(parse_compact_graph(source, file).unwrap()).unwrap()
}

fn execute_with_host(
    source: &str,
    file: &str,
    host: MemoryHost,
) -> (revia_core::vm::VmResult, MemoryHost) {
    let graph = checked(source, file);
    let artifact = translate_graph(&graph).unwrap();
    let artifact_source = serialize_bytecode_artifact(&artifact).unwrap();
    let revision = graph_revision(&graph).unwrap();
    let request = VmRequest::new(
        revision.clone(),
        artifact.artifact_digest,
        artifact.profile,
        INPUT_DIGEST,
    );
    let mut bridge = HostBackedBridge::new(&graph, host, revision, INPUT_DIGEST).unwrap();
    let result = execute_bytecode(
        &graph,
        &artifact_source,
        &request,
        &mut bridge,
        VmLimits::default(),
    )
    .unwrap();
    (result, bridge.into_host())
}

#[test]
fn native_host_executor_commits_real_stdout_to_the_explicit_host() {
    let (result, host) = execute_with_host(
        HELLO,
        "hello.re",
        MemoryHost::new(Vec::new(), BTreeMap::new(), BTreeMap::new()),
    );

    assert_eq!(result.outcome.code, 0);
    assert_eq!(host.stdout_bytes(), b"Hello, World!\n");
    assert_eq!(result.invocations[0].outcome, "ok");
}

#[test]
fn native_host_executor_reads_a_sandboxed_file_through_the_host_adapter() {
    let mut host = MemoryHost::new(Vec::new(), BTreeMap::new(), BTreeMap::new());
    host.seed_files(BTreeMap::from([(
        "input.txt".to_owned(),
        b"native input".to_vec(),
    )]));

    let (result, host) = execute_with_host(READ, "read-encoding.re", host);

    assert_eq!(result.outcome.code, 0);
    assert_eq!(host.stdout_bytes(), b"");
    assert_eq!(result.invocations[0].outcome, "ok");
}

#[test]
fn native_host_executor_maps_missing_file_to_the_declared_error_branch() {
    let (result, _) = execute_with_host(
        READ,
        "read-encoding.re",
        MemoryHost::new(Vec::new(), BTreeMap::new(), BTreeMap::new()),
    );

    assert_eq!(result.outcome.code, 2);
    assert_eq!(result.invocations[0].outcome, "err");
}

#[test]
fn native_host_executor_rejects_unexpected_host_result_shape_as_a_closed_fault() {
    struct WrongShapeHost;

    impl HostAdapter for WrongShapeHost {
        fn invoke(&mut self, _request: &HostRequest) -> Result<HostOutcome, StdError> {
            Ok(HostOutcome::Bytes(vec![1, 2, 3]))
        }

        fn close_secrets(&mut self) {}
    }

    let graph = checked(HELLO, "hello.re");
    let revision = graph_revision(&graph).unwrap();
    let mut bridge =
        HostBackedBridge::new(&graph, WrongShapeHost, revision.clone(), INPUT_DIGEST).unwrap();
    let error = revia_core::vm::CapabilityBridge::invoke(
        &mut bridge,
        "@stdout",
        "write",
        &BTreeMap::from([(
            "data".to_owned(),
            revia_core::vm::VmValue::Text("hello".to_owned()),
        )]),
        "invocation",
    )
    .unwrap()
    .clone();
    assert_eq!(
        error,
        revia_core::vm::CapabilityResponse::HostFault {
            code: "native-host-return-type-mismatch".to_owned(),
        }
    );
}

#[test]
fn native_host_executor_keeps_host_panics_inside_the_closed_fault_boundary() {
    struct PanickingHost;

    impl HostAdapter for PanickingHost {
        fn invoke(&mut self, _request: &HostRequest) -> Result<HostOutcome, StdError> {
            panic!("host detail must not escape");
        }

        fn close_secrets(&mut self) {}
    }

    let mut host = HostEnvironment::new(PanickingHost);
    assert_eq!(
        host.invoke(HostRequest::process_args()).unwrap_err(),
        StdError::HostFault
    );
}
