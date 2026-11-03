use std::collections::BTreeMap;

use revia_core::{
    cross_language::observed_replay_result_digest,
    graph::load_canonical_graph,
    replay::{
        NativeReplayTranscript, parse_native_replay_transcript, serialize_native_replay_transcript,
    },
    vm::{CapabilityResponse, VmValue},
};

const SOURCE: &str = include_str!("../../../test/golden/canonical-hello.re");
const INVOCATION_ID: &str = "aaaaaadaaaaaaaaaaaaaaaaaaa";
const UNSUPPORTED: &str = "cross-language-observed-stdout-unsupported";

fn transcript(member: &str, data: VmValue) -> NativeReplayTranscript {
    parse_native_replay_transcript(
        &serialize_native_replay_transcript(&NativeReplayTranscript::new(vec![
            revia_core::replay::NativeReplayInvocation::new(
                "@stdout",
                member,
                INVOCATION_ID,
                BTreeMap::from([("data".to_owned(), data)]),
                CapabilityResponse::Value {
                    variant: "ok".to_owned(),
                    payload: VmValue::Unit,
                },
            ),
        ]))
        .unwrap(),
    )
    .unwrap()
}

fn observed(transcript: &NativeReplayTranscript) -> Result<String, String> {
    let graph = load_canonical_graph(SOURCE).unwrap();
    observed_replay_result_digest(&graph, transcript, 0, "process.status")
        .map_err(|error| error.code)
}

#[test]
fn text_stdout_data_is_still_observable() {
    let value = transcript("write", VmValue::Text("Hello, World!\n".to_owned()));
    assert!(observed(&value).is_ok());
}

#[test]
fn non_text_stdout_data_is_rejected_instead_of_skipped() {
    // Skipping would project zero bytes and make two different runs compare
    // equal, so the projection fails closed on anything it cannot observe.
    let value = transcript("write", VmValue::Int(7));
    assert_eq!(observed(&value).unwrap_err(), UNSUPPORTED);
}

#[test]
fn missing_stdout_data_is_rejected_instead_of_skipped() {
    let value = transcript("write", VmValue::Unit);
    assert_eq!(observed(&value).unwrap_err(), UNSUPPORTED);
}

#[test]
fn non_write_stdout_member_is_rejected() {
    let value = transcript("read", VmValue::Text("Hello, World!\n".to_owned()));
    assert_eq!(observed(&value).unwrap_err(), UNSUPPORTED);
}
