use std::collections::BTreeMap;
use std::fs;
use std::io::Cursor;
use std::path::PathBuf;
use std::process::Command;

use revia_core::minimal_std::{
    HostAdapter, HostBackedBridge, HostEnvironment, HostOutcome, HostRequest, MemoryHost,
    NativeStdRequest, StdError, StdOperation, StdValue, SystemHost, execute_minimal_std,
};
use revia_core::vm::CapabilityBridge;
use revia_core::{
    bytecode::{serialize_bytecode_artifact, translate_graph},
    graph::{check_graph, graph_revision, parse_compact_graph},
    vm::{VmLimits, VmRequest, execute_bytecode},
};

const HELLO: &str = include_str!("../../../examples/hello.re");

fn bytes(values: &[u8]) -> StdValue {
    StdValue::Bytes(values.to_vec())
}

fn args(entries: &[(&str, StdValue)]) -> BTreeMap<String, StdValue> {
    entries
        .iter()
        .map(|(name, value)| ((*name).to_owned(), value.clone()))
        .collect()
}

fn std_request(operation: StdOperation, arguments: BTreeMap<String, StdValue>) -> NativeStdRequest {
    NativeStdRequest::new(
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        operation,
        arguments,
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    )
}

#[test]
fn native_std_executes_all_frozen_operations_with_closed_values() {
    let cases = [
        (
            StdOperation::BytesByteCount,
            args(&[("value", bytes(&[1, 2, 3]))]),
            StdValue::Int("3".to_owned()),
        ),
        (
            StdOperation::BytesConcat,
            args(&[("left", bytes(&[1])), ("right", bytes(&[2, 3]))]),
            bytes(&[1, 2, 3]),
        ),
        (
            StdOperation::BytesDecodeUtf8,
            args(&[("value", bytes(b"hello"))]),
            StdValue::ResultOk(Box::new(StdValue::Text("hello".to_owned()))),
        ),
        (
            StdOperation::ListAppend,
            args(&[
                ("value", StdValue::Int("2".to_owned())),
                (
                    "values",
                    StdValue::List(vec![StdValue::Int("1".to_owned())]),
                ),
            ]),
            StdValue::List(vec![
                StdValue::Int("1".to_owned()),
                StdValue::Int("2".to_owned()),
            ]),
        ),
        (
            StdOperation::ListConcat,
            args(&[
                ("left", StdValue::List(vec![StdValue::Bool(true)])),
                ("right", StdValue::List(vec![StdValue::Bool(false)])),
            ]),
            StdValue::List(vec![StdValue::Bool(true), StdValue::Bool(false)]),
        ),
        (
            StdOperation::ListLength,
            args(&[(
                "values",
                StdValue::List(vec![StdValue::Unit, StdValue::Unit]),
            )]),
            StdValue::Int("2".to_owned()),
        ),
        (
            StdOperation::ResultIsErr,
            args(&[(
                "value",
                StdValue::ResultErr {
                    type_name: "error".to_owned(),
                    variant: "bad".to_owned(),
                },
            )]),
            StdValue::Bool(true),
        ),
        (
            StdOperation::ResultIsOk,
            args(&[("value", StdValue::ResultOk(Box::new(StdValue::Unit)))]),
            StdValue::Bool(true),
        ),
        (
            StdOperation::TextConcat,
            args(&[
                ("left", StdValue::Text("re".to_owned())),
                ("right", StdValue::Text("via".to_owned())),
            ]),
            StdValue::Text("revia".to_owned()),
        ),
        (
            StdOperation::TextEncodeUtf8,
            args(&[("value", StdValue::Text("中".to_owned()))]),
            bytes("中".as_bytes()),
        ),
        (
            StdOperation::TextScalarCount,
            args(&[("value", StdValue::Text("a中".to_owned()))]),
            StdValue::Int("2".to_owned()),
        ),
    ];

    for (operation, arguments, expected) in cases {
        let result = execute_minimal_std(&std_request(operation, arguments))
            .unwrap_or_else(|error| panic!("{operation:?}: {error:?}"));
        assert_eq!(result, expected, "{operation:?}");
    }
}

#[test]
fn native_std_rejects_invalid_utf8_and_argument_shape_without_guessing() {
    let invalid = execute_minimal_std(&std_request(
        StdOperation::BytesDecodeUtf8,
        args(&[("value", bytes(&[0xc3, 0x28]))]),
    ))
    .unwrap();
    assert_eq!(
        invalid,
        StdValue::ResultErr {
            type_name: "std.bytes.decode_error".to_owned(),
            variant: "invalid_utf8".to_owned(),
        }
    );

    let mismatch = execute_minimal_std(&std_request(
        StdOperation::BytesByteCount,
        args(&[("value", StdValue::Text("not-bytes".to_owned()))]),
    ))
    .unwrap_err();
    assert_eq!(mismatch, StdError::ArgumentTypeMismatch);

    let extra = execute_minimal_std(&std_request(
        StdOperation::TextConcat,
        args(&[
            ("left", StdValue::Text("a".to_owned())),
            ("right", StdValue::Text("b".to_owned())),
            ("extra", StdValue::Unit),
        ]),
    ))
    .unwrap_err();
    assert_eq!(extra, StdError::ArgumentsMismatch);

    let invalid_integer = NativeStdRequest::new(
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        StdOperation::ListLength,
        args(&[(
            "values",
            StdValue::List(vec![StdValue::Int("-".to_owned())]),
        )]),
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    assert_eq!(
        execute_minimal_std(&invalid_integer).unwrap_err(),
        StdError::ValueInvalid
    );
}

#[test]
fn native_std_rejects_uppercase_digest_and_output_overflow() {
    let uppercase = NativeStdRequest::new(
        "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        StdOperation::BytesByteCount,
        args(&[("value", bytes(&[1]))]),
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    assert_eq!(
        execute_minimal_std(&uppercase).unwrap_err(),
        StdError::GraphRevisionInvalid
    );

    let mut left = vec![0_u8; 1_048_576];
    left[0] = 1;
    let overflow = execute_minimal_std(&std_request(
        StdOperation::BytesConcat,
        args(&[("left", bytes(&left)), ("right", bytes(&[2]))]),
    ));
    assert_eq!(overflow.unwrap_err(), StdError::ResourceLimitExceeded);
}

#[test]
fn native_std_request_binds_operation_input_and_authority() {
    let request = std_request(
        StdOperation::BytesByteCount,
        args(&[("value", bytes(&[1, 2]))]),
    );
    assert_eq!(
        request,
        NativeStdRequest::new(
            request.graph_revision.clone(),
            request.operation,
            request.arguments.clone(),
            request.input_digest.clone(),
        )
    );

    let mut drifted = request.clone();
    drifted.input_digest =
        "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc".to_owned();
    assert_eq!(
        execute_minimal_std(&drifted).unwrap_err(),
        StdError::RequestDigestMismatch
    );
}

#[test]
fn host_environment_uses_only_explicit_adapters_and_closes_secret_snapshot() {
    let mut host = HostEnvironment::new(MemoryHost::new(
        vec!["revia".to_owned(), "--check".to_owned()],
        BTreeMap::from([("MODE".to_owned(), "test".to_owned())]),
        BTreeMap::from([("API_KEY".to_owned(), vec![1, 2, 3])]),
    ));

    assert_eq!(
        host.invoke(HostRequest::process_args()).unwrap(),
        HostOutcome::Args(vec!["revia".to_owned(), "--check".to_owned()])
    );
    assert_eq!(
        host.invoke(HostRequest::environment("MODE")).unwrap(),
        HostOutcome::Text("test".to_owned())
    );
    assert_eq!(
        host.invoke(HostRequest::secret("API_KEY")).unwrap(),
        HostOutcome::Bytes(vec![1, 2, 3])
    );
    host.close_secrets();
    assert_eq!(
        host.invoke(HostRequest::secret("API_KEY")).unwrap_err(),
        StdError::SecretClosed
    );

    let mut memory = MemoryHost::new(Vec::new(), BTreeMap::new(), BTreeMap::new());
    memory.seed_files(BTreeMap::from([(
        "read.txt".to_owned(),
        b"memory".to_vec(),
    )]));
    assert_eq!(
        memory.invoke(&HostRequest::file_read("read.txt")).unwrap(),
        HostOutcome::Text("memory".to_owned())
    );
}

#[test]
fn host_environment_rejects_sandbox_escape_and_unknown_authority_before_io() {
    let mut host = HostEnvironment::new(MemoryHost::new(
        Vec::new(),
        BTreeMap::new(),
        BTreeMap::new(),
    ));

    assert_eq!(
        host.invoke(HostRequest::file_read("../outside"))
            .unwrap_err(),
        StdError::PathOutsideSandbox
    );
    assert_eq!(
        host.invoke(HostRequest::unknown("host.exec")).unwrap_err(),
        StdError::UnknownOperation
    );

    let mut request = HostRequest::environment("MODE");
    request.authority.profile = "wrong-profile".to_owned();
    assert_eq!(
        host.invoke(request).unwrap_err(),
        StdError::HostAuthorityMismatch
    );
}

#[test]
fn system_host_confines_real_files_and_does_not_follow_write_symlinks() {
    let root = unique_temp("wp257-host");
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("input.txt"), b"native").unwrap();
    let random_path = root.join("random.bin");
    fs::write(&random_path, [7_u8; 8]).unwrap();
    let outside = unique_temp("wp257-outside");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("secret.txt"), b"outside").unwrap();

    #[cfg(unix)]
    std::os::unix::fs::symlink(outside.join("secret.txt"), root.join("link.txt")).unwrap();

    let mut host = SystemHost::new(
        &root,
        vec!["revia".to_owned()],
        BTreeMap::new(),
        BTreeMap::new(),
        Box::new(Vec::<u8>::new()),
        &random_path,
    )
    .unwrap();
    assert_eq!(
        host.invoke(&HostRequest::file_read("input.txt")).unwrap(),
        HostOutcome::Text("native".to_owned())
    );
    assert_eq!(
        host.invoke(&HostRequest::file_write("output.txt", b"ok".to_vec()))
            .unwrap(),
        HostOutcome::Unit
    );
    assert_eq!(fs::read(root.join("output.txt")).unwrap(), b"ok");

    #[cfg(unix)]
    assert_eq!(
        host.invoke(&HostRequest::file_write("link.txt", b"overwrite".to_vec()))
            .unwrap_err(),
        StdError::PathOutsideSandbox
    );

    fs::write(root.join("invalid.bin"), [0xc3_u8, 0x28]).unwrap();
    assert_eq!(
        host.invoke(&HostRequest::file_read("invalid.bin"))
            .unwrap_err(),
        StdError::InvalidUtf8
    );

    let _ = fs::remove_dir_all(root);
    let _ = fs::remove_dir_all(outside);
}

#[test]
fn system_host_accepts_an_injected_random_reader() {
    let root = unique_temp("wp257-random-reader");
    fs::create_dir_all(&root).unwrap();
    let mut host = SystemHost::new_with_random_reader(
        &root,
        Vec::new(),
        BTreeMap::new(),
        BTreeMap::new(),
        Box::new(Vec::<u8>::new()),
        Box::new(Cursor::new(vec![7_u8; 32])),
    )
    .unwrap();

    assert_eq!(
        host.invoke(&HostRequest::random(4)).unwrap(),
        HostOutcome::Bytes(vec![7_u8; 4])
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn system_host_atomic_write_preserves_failed_destination_and_cleans_staging_file() {
    let root = unique_temp("wp280-atomic-write");
    fs::create_dir_all(root.join("target")).unwrap();
    let random_path = root.join("random.bin");
    fs::write(&random_path, [7_u8; 8]).unwrap();
    let mut host = SystemHost::new(
        &root,
        Vec::new(),
        BTreeMap::new(),
        BTreeMap::new(),
        Box::new(Vec::<u8>::new()),
        &random_path,
    )
    .unwrap();

    assert_eq!(
        host.invoke(&HostRequest::file_write("target", b"replacement".to_vec()))
            .unwrap_err(),
        StdError::HostFault
    );
    assert!(root.join("target").is_dir());
    assert!(
        fs::read_dir(&root)
            .unwrap()
            .filter_map(Result::ok)
            .all(|entry| !entry
                .file_name()
                .to_string_lossy()
                .starts_with(".revia-host-write-"))
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn native_std_bridge_preserves_boolean_results_and_rejects_unknown_members() {
    let mut bridge = revia_core::minimal_std::MinimalStdBridge::new(
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    )
    .unwrap();
    let values = BTreeMap::from([(
        "value".to_owned(),
        revia_core::vm::VmValue::ResultErr {
            type_name: "error".to_owned(),
            variant: "bad".to_owned(),
        },
    )]);
    assert_eq!(
        revia_core::vm::CapabilityBridge::invoke(
            &mut bridge,
            "std.result",
            "is_err",
            &values,
            "invocation",
        )
        .unwrap(),
        revia_core::vm::CapabilityResponse::ok(revia_core::vm::VmValue::Bool(true))
    );
    assert_eq!(
        revia_core::vm::CapabilityBridge::invoke(
            &mut bridge,
            "std.result",
            "unknown",
            &values,
            "invocation",
        )
        .unwrap_err(),
        "minimal-std-bridge-operation-unknown"
    );
}

#[test]
fn native_std_bridge_requires_explicit_vm_authority_match() {
    let bridge = revia_core::minimal_std::MinimalStdBridge::new(
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    )
    .unwrap();
    assert_eq!(
        bridge.verify_authority(
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        ),
        Ok(())
    );
    assert_eq!(
        bridge.verify_authority(
            "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        ),
        Err("minimal-std-bridge-authority-mismatch".to_owned())
    );
}

#[test]
fn native_vm_checks_minimal_std_bridge_authority_before_invocation() {
    let graph = check_graph(parse_compact_graph(HELLO, "hello.re").unwrap()).unwrap();
    let artifact = translate_graph(&graph).unwrap();
    let source = serialize_bytecode_artifact(&artifact).unwrap();
    let request = VmRequest::new(
        graph_revision(&graph).unwrap(),
        artifact.artifact_digest.clone(),
        artifact.profile.clone(),
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    let mut bridge = revia_core::minimal_std::MinimalStdBridge::new(
        "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        request.input_digest.clone(),
    )
    .unwrap();
    let error =
        execute_bytecode(&graph, &source, &request, &mut bridge, VmLimits::default()).unwrap_err();
    assert_eq!(error.code, "native-vm-capability-authority-mismatch");
}

#[test]
fn host_backed_bridge_does_not_union_capabilities_across_graph_authorities() {
    let hello = check_graph(parse_compact_graph(HELLO, "hello.re").unwrap()).unwrap();
    let write = check_graph(
        parse_compact_graph(include_str!("../../../examples/write-check.re"), "write.re").unwrap(),
    )
    .unwrap();
    let hello_revision = graph_revision(&hello).unwrap();
    let write_revision = graph_revision(&write).unwrap();
    let mut bridge = HostBackedBridge::new_for_graphs(
        &[&hello, &write],
        MemoryHost::new(Vec::new(), BTreeMap::new(), BTreeMap::new()),
        hello_revision,
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    )
    .unwrap();

    bridge
        .verify_authority(
            graph_revision(&hello).unwrap().as_str(),
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        )
        .unwrap();
    let arguments = BTreeMap::from([
        (
            "data".to_owned(),
            revia_core::vm::VmValue::Bytes(b"payload".to_vec()),
        ),
        (
            "path".to_owned(),
            revia_core::vm::VmValue::Text("output.txt".to_owned()),
        ),
    ]);
    assert_eq!(
        CapabilityBridge::invoke(
            &mut bridge,
            "@output",
            "write_file",
            &arguments,
            "invocation",
        )
        .unwrap_err(),
        "native-host-bridge-capability-unknown"
    );

    bridge
        .verify_authority(
            write_revision.as_str(),
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        )
        .unwrap();
    assert_eq!(
        CapabilityBridge::invoke(
            &mut bridge,
            "@output",
            "write_file",
            &arguments,
            "invocation",
        )
        .unwrap(),
        revia_core::vm::CapabilityResponse::ok(revia_core::vm::VmValue::Unit)
    );
}

#[test]
fn host_backed_bridge_records_path_free_observations_in_invocation_order() {
    let graph = check_graph(parse_compact_graph(HELLO, "hello.re").unwrap()).unwrap();
    let revision = graph_revision(&graph).unwrap();
    let mut bridge = HostBackedBridge::new(
        &graph,
        MemoryHost::new(Vec::new(), BTreeMap::new(), BTreeMap::new()),
        revision,
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    )
    .unwrap();
    let arguments = BTreeMap::from([(
        "data".to_owned(),
        revia_core::vm::VmValue::Text("Hello, World!\n".to_owned()),
    )]);

    CapabilityBridge::invoke(&mut bridge, "@stdout", "write", &arguments, "invocation").unwrap();

    assert_eq!(bridge.observations().len(), 1);
    let observation = &bridge.observations()[0];
    assert_eq!(observation.sequence, 0);
    assert_eq!(observation.operation, "process.stdout.write");
    assert_eq!(observation.outcome, "unit");
    assert!(observation.effect_committed);
    assert!(observation.argument_digest.starts_with("sha256:"));
    assert!(observation.payload_digest.starts_with("sha256:"));
    assert!(!format!("{observation:?}").contains("Hello, World!"));
}

#[test]
fn host_backed_bridge_observations_bind_to_vm_invocation_order() {
    let graph = check_graph(
        parse_compact_graph(
            include_str!("../../../examples/write-check.re"),
            "write-check.re",
        )
        .unwrap(),
    )
    .unwrap();
    let artifact = translate_graph(&graph).unwrap();
    let artifact_source = serialize_bytecode_artifact(&artifact).unwrap();
    let revision = graph_revision(&graph).unwrap();
    let input_digest = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    let request = VmRequest::new(
        revision.clone(),
        artifact.artifact_digest.clone(),
        artifact.profile.clone(),
        input_digest,
    );
    let mut bridge = HostBackedBridge::new(
        &graph,
        MemoryHost::new(Vec::new(), BTreeMap::new(), BTreeMap::new()),
        revision,
        input_digest,
    )
    .unwrap();

    let result = execute_bytecode(
        &graph,
        &artifact_source,
        &request,
        &mut bridge,
        VmLimits::default(),
    )
    .unwrap();

    assert_eq!(bridge.observations().len(), result.invocations.len());
    let observation = &bridge.observations()[0];
    let invocation = &result.invocations[0];
    assert_eq!(observation.sequence, 0);
    assert_eq!(observation.invocation_id, invocation.invocation_id);
    assert_eq!(observation.instance, invocation.instance);
    assert_eq!(observation.member, invocation.member);
    assert_eq!(observation.outcome, "unit");
    assert!(observation.effect_committed);
}

#[test]
fn host_backed_bridge_records_failed_host_observation_without_effect_commit() {
    let graph = check_graph(parse_compact_graph(HELLO, "hello.re").unwrap()).unwrap();
    let revision = graph_revision(&graph).unwrap();
    let mut bridge = HostBackedBridge::new(
        &graph,
        MemoryHost::new(Vec::new(), BTreeMap::new(), BTreeMap::new()),
        revision,
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    )
    .unwrap();
    let arguments = BTreeMap::from([
        (
            "data".to_owned(),
            revia_core::vm::VmValue::Text("x".to_owned()),
        ),
        ("extra".to_owned(), revia_core::vm::VmValue::Unit),
    ]);

    let response = CapabilityBridge::invoke(&mut bridge, "@stdout", "write", &arguments, "failed");

    assert_eq!(
        response,
        Err("native-host-bridge-operation-unsupported:@stdout.write".to_owned())
    );
    assert_eq!(bridge.observations().len(), 1);
    let observation = &bridge.observations()[0];
    assert_eq!(observation.invocation_id, "failed");
    assert_eq!(observation.operation, "process.stdout.write");
    assert_eq!(observation.outcome, "error");
    assert_eq!(
        observation.error.as_deref(),
        Some("native-host-bridge-operation-unsupported:@stdout.write")
    );
    assert!(!observation.effect_committed);
    assert!(!format!("{observation:?}").contains('x'));
}

#[test]
fn host_environment_panic_does_not_leak_payload_to_stderr() {
    if std::env::var_os("REVIA_HOST_PANIC_CHILD").is_some() {
        struct PanickingHost;

        impl HostAdapter for PanickingHost {
            fn invoke(&mut self, _request: &HostRequest) -> Result<HostOutcome, StdError> {
                panic!("host-secret-payload-should-not-escape");
            }

            fn close_secrets(&mut self) {}
        }

        let mut host = HostEnvironment::new(PanickingHost);
        assert_eq!(
            host.invoke(HostRequest::process_args()).unwrap_err(),
            StdError::HostFault
        );
        return;
    }

    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "host_environment_panic_does_not_leak_payload_to_stderr",
            "--nocapture",
        ])
        .env("REVIA_HOST_PANIC_CHILD", "1")
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    assert!(!String::from_utf8_lossy(&output.stderr).contains("host-secret-payload"));
}

#[test]
fn host_environment_sanitizes_adapter_panics() {
    struct PanickingHost;

    impl HostAdapter for PanickingHost {
        fn invoke(&mut self, _request: &HostRequest) -> Result<HostOutcome, StdError> {
            panic!("adapter detail must not escape");
        }

        fn close_secrets(&mut self) {}
    }

    let mut host = HostEnvironment::new(PanickingHost);
    assert_eq!(
        host.invoke(HostRequest::process_args()).unwrap_err(),
        StdError::HostFault
    );
}

fn unique_temp(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "revia-{label}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}
