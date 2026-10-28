use std::collections::BTreeMap;

use revia_core::{
    replay::{
        NativeReplayInvocation, NativeReplayTranscript, ReplayBridge,
        parse_native_replay_transcript, serialize_native_replay_transcript,
    },
    vm::{CapabilityBridge, CapabilityResponse, VmValue},
};

const TRANSCRIPT: &str = concat!(
    "{\"invocations\":[{\"arguments\":{\"data\":{\"type\":\"text.utf8\",",
    "\"value\":\"Hello, World!\\n\"}},\"instance\":\"@stdout\",",
    "\"invocation_id\":\"aaaaaacaaaaaaaaaaaaaaaaaaa\",\"member\":\"write\",",
    "\"response\":{\"kind\":\"value\",\"payload\":{\"type\":\"unit\",",
    "\"value\":null},\"variant\":\"ok\"}}],",
    "\"schema\":\"re.native-vm-replay@0.1.0\"}\n"
);

#[test]
fn native_replay_transcript_round_trips_and_matches_a_vm_invocation() {
    let transcript = parse_native_replay_transcript(TRANSCRIPT).unwrap();
    assert_eq!(
        serialize_native_replay_transcript(&transcript).unwrap(),
        TRANSCRIPT
    );
    let mut bridge = ReplayBridge::new(transcript);
    let arguments = BTreeMap::from([(
        "data".to_owned(),
        VmValue::Text("Hello, World!\n".to_owned()),
    )]);

    let response = bridge
        .invoke("@stdout", "write", &arguments, "aaaaaacaaaaaaaaaaaaaaaaaaa")
        .unwrap();
    assert_eq!(response, CapabilityResponse::ok(VmValue::Unit));
    bridge.finish().unwrap();
}

#[test]
fn native_replay_transcript_rejects_noncanonical_and_invocation_drift() {
    let noncanonical = TRANSCRIPT.replace("\"schema\":", " \"schema\":");
    assert_eq!(
        parse_native_replay_transcript(&noncanonical)
            .unwrap_err()
            .code,
        "native-replay-transcript-non-canonical-source"
    );

    let transcript = parse_native_replay_transcript(TRANSCRIPT).unwrap();
    let mut bridge = ReplayBridge::new(transcript);
    let error = bridge
        .invoke(
            "@stdout",
            "read",
            &BTreeMap::new(),
            "aaaaaacaaaaaaaaaaaaaaaaaaa",
        )
        .unwrap_err();
    assert_eq!(error, "native-conformance-replay-invocation-mismatch");
    assert_eq!(
        bridge.finish().unwrap_err(),
        "native-conformance-replay-invocation-mismatch"
    );
}

#[test]
fn native_replay_transcript_rejects_duplicate_fields_and_malformed_responses() {
    let duplicate =
        TRANSCRIPT.replacen("{\"invocations\"", "{\"invocations\":[],\"invocations\"", 1);
    assert_eq!(
        parse_native_replay_transcript(&duplicate).unwrap_err().code,
        "native-replay-transcript-duplicate-field"
    );

    let malformed = TRANSCRIPT.replace("\"variant\":\"ok\"", "\"variant\":\"maybe\"");
    assert_eq!(
        parse_native_replay_transcript(&malformed).unwrap_err().code,
        "native-replay-transcript-response-invalid"
    );
}

#[test]
fn native_replay_bridge_rejects_out_of_order_invocations() {
    let first = NativeReplayInvocation::new(
        "@stdout",
        "write",
        "first",
        BTreeMap::new(),
        CapabilityResponse::ok(VmValue::Unit),
    );
    let second = NativeReplayInvocation::new(
        "@stdout",
        "write",
        "second",
        BTreeMap::new(),
        CapabilityResponse::ok(VmValue::Unit),
    );
    let mut bridge = ReplayBridge::new(NativeReplayTranscript::new(vec![first, second]));
    assert_eq!(
        bridge
            .invoke("@stdout", "write", &BTreeMap::new(), "second")
            .unwrap_err(),
        "native-conformance-replay-invocation-mismatch"
    );
}

#[test]
fn native_replay_types_are_explicit() {
    let invocation = NativeReplayInvocation::new(
        "@stdout",
        "write",
        "aaaaaacaaaaaaaaaaaaaaaaaaa",
        BTreeMap::new(),
        CapabilityResponse::ok(VmValue::Unit),
    );
    let transcript = NativeReplayTranscript::new(vec![invocation]);
    assert_eq!(transcript.schema, "re.native-vm-replay@0.1.0");
}
