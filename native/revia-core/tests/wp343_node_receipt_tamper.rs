use std::{fs, path::PathBuf, process::Command};

use revia_core::{
    canonical_json::{JsonValue, canonicalize},
    cross_language::observed_node_run_result_digest,
    digest::sha256_hex,
    graph::{check_graph, graph_revision, load_canonical_graph, parse_compact_graph},
    project::parse_json,
    replay::parse_native_replay_transcript,
    source::SourceText,
};

const GRAPH: &str = "test/golden/canonical-hello.re";
const TRANSCRIPT: &str = concat!(
    "{\"invocations\":[{\"arguments\":{\"data\":{\"type\":\"text.utf8\",",
    "\"value\":\"Hello, World!\\n\"}},\"instance\":\"@stdout\",",
    "\"invocation_id\":\"aaaaaadaaaaaaaaaaaaaaaaaaa\",\"member\":\"write\",",
    "\"response\":{\"kind\":\"value\",\"payload\":{\"type\":\"unit\",",
    "\"value\":null},\"variant\":\"ok\"}}],",
    "\"schema\":\"re.native-vm-replay@0.1.0\"}\n"
);

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn load_graph(path: &std::path::Path) -> revia_core::graph::Graph {
    let bytes = fs::read(path).unwrap();
    let source = SourceText::from_bytes(&bytes, path.to_str().unwrap()).unwrap();
    if source.text.starts_with("re 0.1 canonical\n") {
        load_canonical_graph(&source.text).unwrap()
    } else {
        check_graph(parse_compact_graph(&source.text, path.to_str().unwrap()).unwrap()).unwrap()
    }
}

fn node_run_result() -> String {
    let output = Command::new("node")
        .current_dir(repo_root())
        .args([
            "src/cli/re.js",
            "run",
            "--format",
            "json",
            "--runtime-receipt",
            GRAPH,
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "status={} stdout={} stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

type Entries = [(String, JsonValue)];
type Mutation = (&'static str, Box<dyn Fn(&mut Entries)>);

fn entries_mut(value: &mut JsonValue) -> &mut Entries {
    match value {
        JsonValue::Object(entries) => entries,
        _ => panic!("expected object"),
    }
}

fn receipt_mut(document: &mut JsonValue) -> &mut Entries {
    let entries = entries_mut(document);
    let receipt = entries
        .iter_mut()
        .find(|(key, _)| key == "runtime_effect_receipt")
        .map(|(_, value)| value)
        .expect("run result must carry a runtime receipt");
    entries_mut(receipt)
}

fn observation_mut(receipt: &mut Entries, sequence: usize) -> &mut Entries {
    let observations = receipt
        .iter_mut()
        .find(|(key, _)| key == "observations")
        .map(|(_, value)| value)
        .expect("receipt must carry observations");
    match observations {
        JsonValue::Array(values) => entries_mut(&mut values[sequence]),
        _ => panic!("expected observations array"),
    }
}

fn set_field(entries: &mut Entries, key: &str, value: JsonValue) {
    let slot = entries
        .iter_mut()
        .find(|(field, _)| field == key)
        .map(|(_, field)| field)
        .expect("field must exist");
    *slot = value;
}

fn field<'a>(entries: &'a Entries, key: &str) -> &'a JsonValue {
    entries
        .iter()
        .find(|(field, _)| field == key)
        .map(|(_, value)| value)
        .expect("field must exist")
}

fn digest(value: &JsonValue) -> String {
    format!("sha256:{}", sha256_hex(canonicalize(value).as_bytes()))
}

/// Recomputes `demand_id` and `receipt_id` from the observation bytes so that
/// an attacker who can also re-sign the outer receipt still has to make the
/// per-item digests internally consistent.
fn recompute_inner_ids(entries: &mut Entries) {
    let demand_content = JsonValue::Object(vec![
        ("arguments".to_owned(), field(entries, "arguments").clone()),
        ("instance".to_owned(), field(entries, "instance").clone()),
        ("member".to_owned(), field(entries, "member").clone()),
        (
            "occurrence".to_owned(),
            field(entries, "occurrence").clone(),
        ),
        ("reference".to_owned(), field(entries, "reference").clone()),
        (
            "schema".to_owned(),
            JsonValue::String("re.runtime-effect-demand@0.1.0".to_owned()),
        ),
    ]);
    let demand_id = digest(&demand_content);
    let receipt_content = JsonValue::Object(vec![
        ("demand_id".to_owned(), JsonValue::String(demand_id.clone())),
        ("response".to_owned(), field(entries, "response").clone()),
        (
            "schema".to_owned(),
            JsonValue::String("re.runtime-effect-receipt@0.1.0".to_owned()),
        ),
    ]);
    set_field(entries, "demand_id", JsonValue::String(demand_id));
    set_field(
        entries,
        "receipt_id",
        JsonValue::String(digest(&receipt_content)),
    );
}

fn resign_receipt(receipt: &mut Entries) {
    let graph_revision = receipt
        .iter()
        .find(|(key, _)| key == "graph_revision")
        .map(|(_, value)| value.clone())
        .unwrap();
    let observations = receipt
        .iter()
        .find(|(key, _)| key == "observations")
        .map(|(_, value)| value.clone())
        .unwrap();
    let schema = receipt
        .iter()
        .find(|(key, _)| key == "schema")
        .map(|(_, value)| value.clone())
        .unwrap();
    let content = JsonValue::Object(vec![
        ("graph_revision".to_owned(), graph_revision),
        ("observations".to_owned(), observations),
        ("schema".to_owned(), schema),
    ]);
    let digest = format!("sha256:{}", sha256_hex(canonicalize(&content).as_bytes()));
    set_field(receipt, "receipt_digest", JsonValue::String(digest));
}

fn observation_digest_error(source: &str) -> String {
    let graph = load_graph(&repo_root().join(GRAPH));
    let revision = graph_revision(&graph).unwrap();
    let transcript = parse_native_replay_transcript(TRANSCRIPT).unwrap();
    observed_node_run_result_digest(source, &graph, &revision, &transcript)
        .unwrap_err()
        .code
}

#[test]
fn real_node_run_result_is_accepted_as_observation_evidence() {
    let graph = load_graph(&repo_root().join(GRAPH));
    let revision = graph_revision(&graph).unwrap();
    let transcript = parse_native_replay_transcript(TRANSCRIPT).unwrap();
    let digest =
        observed_node_run_result_digest(&node_run_result(), &graph, &revision, &transcript)
            .unwrap();
    assert!(digest.starts_with("sha256:") && digest.len() == 71);
}

#[test]
fn per_item_receipt_tamper_is_rejected_even_after_resigning_outer_digest() {
    let tampered_arguments = JsonValue::Object(vec![
        (
            "data".to_owned(),
            JsonValue::Object(vec![
                ("type".to_owned(), JsonValue::String("text.utf8".to_owned())),
                (
                    "value".to_owned(),
                    JsonValue::String("Tampered\n".to_owned()),
                ),
            ]),
        ),
        (
            "type".to_owned(),
            JsonValue::String("stdout.write".to_owned()),
        ),
    ]);
    let tampered_response = JsonValue::Object(vec![
        ("kind".to_owned(), JsonValue::String("value".to_owned())),
        (
            "payload".to_owned(),
            JsonValue::Object(vec![
                ("type".to_owned(), JsonValue::String("unit".to_owned())),
                ("value".to_owned(), JsonValue::Null),
            ]),
        ),
        ("variant".to_owned(), JsonValue::String("err".to_owned())),
    ]);
    let mutations: Vec<Mutation> = vec![
        (
            "parameters",
            Box::new(move |entries| set_field(entries, "arguments", tampered_arguments.clone())),
        ),
        (
            "response",
            Box::new(move |entries| set_field(entries, "response", tampered_response.clone())),
        ),
        (
            "effect instance",
            Box::new(|entries| {
                set_field(entries, "instance", JsonValue::String("@stderr".to_owned()))
            }),
        ),
        (
            "effect member",
            Box::new(|entries| set_field(entries, "member", JsonValue::String("read".to_owned()))),
        ),
        (
            "receipt id",
            Box::new(|entries| {
                set_field(
                    entries,
                    "receipt_id",
                    JsonValue::String(format!("sha256:{}", "0".repeat(64))),
                )
            }),
        ),
    ];
    for (name, mutate) in mutations {
        let mut document = parse_json(&node_run_result()).unwrap();
        let receipt = receipt_mut(&mut document);
        mutate(observation_mut(receipt, 0));
        resign_receipt(receipt);
        let source = canonicalize(&document);
        let code = observation_digest_error(&source);
        assert_eq!(
            code, "cross-language-node-effect-receipt-observation-digest-mismatch",
            "{name} tamper after re-signing must still be rejected"
        );
    }
}

#[test]
fn re_signed_observation_bytes_are_rejected_by_the_transcript_projection() {
    let mut document = parse_json(&node_run_result()).unwrap();
    let receipt = receipt_mut(&mut document);
    let tampered_arguments = JsonValue::Object(vec![
        (
            "data".to_owned(),
            JsonValue::Object(vec![
                ("type".to_owned(), JsonValue::String("text.utf8".to_owned())),
                (
                    "value".to_owned(),
                    JsonValue::String("Tampered\n".to_owned()),
                ),
            ]),
        ),
        (
            "type".to_owned(),
            JsonValue::String("stdout.write".to_owned()),
        ),
    ]);
    {
        let observation = observation_mut(receipt, 0);
        set_field(observation, "arguments", tampered_arguments);
        recompute_inner_ids(observation);
    }
    resign_receipt(receipt);
    let code = observation_digest_error(&canonicalize(&document));
    assert_eq!(code, "cross-language-node-effect-observation-mismatch");
}

type IdentityMutation = (&'static str, fn(&mut Entries), &'static str);

#[test]
fn re_signed_identity_and_sequence_tamper_is_rejected_before_projection() {
    let mutations: Vec<IdentityMutation> = vec![
        (
            "effect uid",
            |entries| {
                set_field(
                    entries,
                    "effect_uid",
                    JsonValue::String("bbbbbbbaaaaaaaaaaaaaaaaaaa".to_owned()),
                )
            },
            "cross-language-node-effect-receipt-observation-digest-mismatch",
        ),
        (
            "empty effect uid",
            |entries| set_field(entries, "effect_uid", JsonValue::String(String::new())),
            "cross-language-node-effect-receipt-invalid",
        ),
        (
            "sequence",
            |entries| set_field(entries, "sequence", JsonValue::Number("1".to_owned())),
            "cross-language-node-effect-receipt-invalid",
        ),
        (
            "occurrence",
            |entries| set_field(entries, "occurrence", JsonValue::Number("1".to_owned())),
            "cross-language-node-effect-receipt-demand-mismatch",
        ),
    ];
    for (name, mutate, expected) in mutations {
        let mut document = parse_json(&node_run_result()).unwrap();
        let receipt = receipt_mut(&mut document);
        mutate(observation_mut(receipt, 0));
        resign_receipt(receipt);
        let code = observation_digest_error(&canonicalize(&document));
        assert_eq!(code, expected, "{name} tamper must be rejected");
    }

    let mut document = parse_json(&node_run_result()).unwrap();
    let receipt = receipt_mut(&mut document);
    set_field(
        receipt,
        "graph_revision",
        JsonValue::String(format!("sha256:{}", "a".repeat(64))),
    );
    resign_receipt(receipt);
    let code = observation_digest_error(&canonicalize(&document));
    assert_eq!(
        code, "cross-language-node-effect-receipt-authority-mismatch",
        "graph revision tamper must be rejected by receipt authority"
    );
}

#[test]
fn null_receipt_with_a_non_empty_transcript_is_rejected() {
    let mut document = parse_json(&node_run_result()).unwrap();
    let JsonValue::Object(fields) = &mut document else {
        panic!("node run result must be an object");
    };
    let slot = fields
        .iter_mut()
        .find(|(key, _)| key == "runtime_effect_receipt")
        .map(|(_, value)| value)
        .expect("node run result must carry a runtime receipt");
    *slot = JsonValue::Null;
    let code = observation_digest_error(&canonicalize(&document));
    assert_eq!(code, "cross-language-node-effect-receipt-invalid");
}

#[test]
fn receipt_tamper_without_resigning_is_rejected_by_outer_digest() {
    let mut document = parse_json(&node_run_result()).unwrap();
    let receipt = receipt_mut(&mut document);
    set_field(
        observation_mut(receipt, 0),
        "instance",
        JsonValue::String("@stderr".to_owned()),
    );
    let code = observation_digest_error(&canonicalize(&document));
    assert_eq!(code, "cross-language-node-effect-receipt-digest-mismatch");
}
