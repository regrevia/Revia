use crate::{
    canonical_json::{JsonValue, canonicalize},
    digest::sha256_hex,
};

pub const NODE_FREE_REPORT_SCHEMA: &str = "re.native-node-free-report@0.1.0";
pub const NODE_FREE_BENCHMARK_SCHEMA: &str = "re.native-node-free-benchmark@0.1.0";
pub const NODE_FREE_SAMPLE_SCHEMA: &str = "re.native-node-free-sample@0.1.0";

const REQUIRED_WORKLOADS: [&str; 14] = [
    "check",
    "translate",
    "run",
    "project-init",
    "project-check",
    "project-test",
    "project-build",
    "project-translate",
    "project-run",
    "server-smoke",
    "project-server-smoke",
    "project-execute-plan",
    "project-execute-plan-direct",
    "project-execute-plan-cached",
];
const REQUIRED_CANDIDATES: [&str; 4] = ["native", "go", "jvm", "node"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeGateError {
    pub code: String,
}

impl NativeGateError {
    pub fn new(code: &str) -> Self {
        Self {
            code: code.to_owned(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeWorkloadEvidence {
    pub command: String,
    pub exit_code: i32,
    pub output_digest: String,
    pub semantic_digest: String,
    pub status: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeSample {
    pub adapter_overhead_ns: u128,
    pub cold_build_ns: u128,
    pub p50_ns: u128,
    pub p95_ns: u128,
    pub p99_ns: u128,
    pub peak_rss_bytes: u64,
    pub project_overhead_ns: u128,
    pub round: u32,
    pub semantic_digest: String,
    pub startup_ns: u128,
    pub throughput_ops_per_sec_milli: u128,
    pub warm_build_ns: u128,
    pub workload_digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeCandidate {
    pub language: String,
    pub reason: String,
    pub sample_count: u32,
    pub semantic_mismatch_count: u32,
    pub status: String,
}

impl NativeCandidate {
    pub fn measured(language: &str, sample_count: u32) -> Self {
        Self {
            language: language.to_owned(),
            reason: "measured-native-release".to_owned(),
            sample_count,
            semantic_mismatch_count: 0,
            status: "measured".to_owned(),
        }
    }

    pub fn pending(language: &str, reason: &str) -> Self {
        Self {
            language: language.to_owned(),
            reason: reason.to_owned(),
            sample_count: 0,
            semantic_mismatch_count: 0,
            status: "pending".to_owned(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NodeFreeReport {
    pub benchmark_schema: String,
    pub binary_digest: String,
    pub candidate_status: Vec<NativeCandidate>,
    pub dependency_scan: String,
    pub evidence_digest: String,
    pub node_import_count: u32,
    pub node_load_count: u32,
    pub node_process_count: u32,
    pub performance_eligible: bool,
    pub process_count: u32,
    pub profile_digest: String,
    pub production_claim: bool,
    pub release_build: bool,
    pub report_schema: String,
    pub samples: Vec<NativeSample>,
    pub semantic_mismatch_count: u32,
    pub source_inventory_digest: String,
    pub source_js_file_count: u32,
    pub stable_digest: String,
    pub stable_v1_claim: bool,
    pub toolchain_digest: String,
    pub workloads: Vec<NativeWorkloadEvidence>,
}

impl NodeFreeReport {
    pub fn computed_evidence_digest(&self) -> String {
        digest_json(&evidence_json_without_digest(self))
    }
}

pub fn stable_digest(report: &NodeFreeReport) -> String {
    digest_json(&stable_json(report))
}

pub fn serialize_node_free_report(report: &NodeFreeReport) -> Result<String, NativeGateError> {
    validate_node_free_report(report)?;
    Ok(format!("{}\n", canonicalize(&report_json(report))))
}

pub fn validate_node_free_report(report: &NodeFreeReport) -> Result<(), NativeGateError> {
    if report.report_schema != NODE_FREE_REPORT_SCHEMA
        || report.benchmark_schema != NODE_FREE_BENCHMARK_SCHEMA
        || report.dependency_scan.is_empty()
        || report.performance_eligible
        || report.production_claim
        || report.stable_v1_claim
    {
        return Err(NativeGateError::new("node-free-report-authority-invalid"));
    }
    for digest in [
        &report.binary_digest,
        &report.profile_digest,
        &report.source_inventory_digest,
        &report.toolchain_digest,
    ] {
        if !is_digest(digest) {
            return Err(NativeGateError::new("node-free-digest-invalid"));
        }
    }
    if report.process_count == 0
        || report.source_js_file_count != 0
        || report.node_process_count != 0
        || report.node_load_count != 0
        || report.node_import_count != 0
        || report.semantic_mismatch_count != 0
    {
        return Err(NativeGateError::new("node-free-boundary-invalid"));
    }

    validate_candidates(&report.candidate_status)?;
    validate_workloads(&report.workloads)?;
    validate_samples(report)?;

    if report.evidence_digest != report.computed_evidence_digest() {
        return Err(NativeGateError::new("node-free-evidence-digest-mismatch"));
    }
    if report.stable_digest != stable_digest(report) {
        return Err(NativeGateError::new("node-free-stable-digest-mismatch"));
    }
    Ok(())
}

fn validate_candidates(candidates: &[NativeCandidate]) -> Result<(), NativeGateError> {
    if candidates.len() != REQUIRED_CANDIDATES.len()
        || candidates
            .iter()
            .map(|candidate| candidate.language.as_str())
            .ne(REQUIRED_CANDIDATES)
    {
        return Err(NativeGateError::new("node-free-candidate-set-invalid"));
    }
    let native = &candidates[0];
    if native.status != "measured"
        || native.sample_count < 3
        || native.semantic_mismatch_count != 0
        || candidates[1..].iter().any(|candidate| {
            candidate.status != "pending"
                || candidate.sample_count != 0
                || candidate.semantic_mismatch_count != 0
        })
    {
        return Err(NativeGateError::new("node-free-candidate-status-invalid"));
    }
    Ok(())
}

fn validate_workloads(workloads: &[NativeWorkloadEvidence]) -> Result<(), NativeGateError> {
    if workloads.len() != REQUIRED_WORKLOADS.len()
        || workloads
            .iter()
            .map(|workload| workload.command.as_str())
            .ne(REQUIRED_WORKLOADS)
    {
        return Err(NativeGateError::new("node-free-workload-set-invalid"));
    }
    for workload in workloads {
        if workload.status != "passed"
            || workload.exit_code != 0
            || !is_digest(&workload.output_digest)
            || !is_digest(&workload.semantic_digest)
        {
            return Err(NativeGateError::new("node-free-workload-invalid"));
        }
        if workload.semantic_digest != workload.output_digest {
            return Err(NativeGateError::new("node-free-semantic-mismatch"));
        }
        if workload.command.contains('/')
            || workload.command.contains('\\')
            || workload.command.contains("node")
            || workload.command.contains("npm")
            || workload.command.contains(".js")
        {
            return Err(NativeGateError::new("node-free-workload-boundary-invalid"));
        }
    }
    Ok(())
}

fn validate_samples(report: &NodeFreeReport) -> Result<(), NativeGateError> {
    if report.samples.len() != 3
        || report
            .samples
            .iter()
            .map(|sample| sample.round)
            .ne([0, 1, 2])
    {
        return Err(NativeGateError::new("node-free-sample-set-invalid"));
    }
    for sample in &report.samples {
        if sample.p50_ns > sample.p95_ns || sample.p95_ns > sample.p99_ns {
            return Err(NativeGateError::new("node-free-metric-order-invalid"));
        }
        if sample.peak_rss_bytes == 0
            || sample.throughput_ops_per_sec_milli == 0
            || !is_digest(&sample.semantic_digest)
            || !is_digest(&sample.workload_digest)
        {
            return Err(NativeGateError::new("node-free-metric-invalid"));
        }
        if sample.semantic_digest != workload_semantic_digest(&report.workloads)
            || sample.workload_digest != workload_digest(&report.workloads)
        {
            return Err(NativeGateError::new("node-free-sample-semantic-mismatch"));
        }
    }
    Ok(())
}

pub fn workload_digest(workloads: &[NativeWorkloadEvidence]) -> String {
    digest_json(&JsonValue::Array(
        workloads.iter().map(workload_json).collect(),
    ))
}

pub fn workload_semantic_digest(workloads: &[NativeWorkloadEvidence]) -> String {
    digest_json(&JsonValue::Array(
        workloads
            .iter()
            .map(|workload| JsonValue::String(workload.semantic_digest.clone()))
            .collect(),
    ))
}

fn stable_json(report: &NodeFreeReport) -> JsonValue {
    object(vec![
        (
            "benchmark_schema",
            JsonValue::String(report.benchmark_schema.clone()),
        ),
        (
            "binary_digest",
            JsonValue::String(report.binary_digest.clone()),
        ),
        (
            "candidate_status",
            candidates_json(&report.candidate_status),
        ),
        (
            "dependency_scan",
            JsonValue::String(report.dependency_scan.clone()),
        ),
        (
            "node_import_count",
            JsonValue::Number(report.node_import_count.to_string()),
        ),
        (
            "node_load_count",
            JsonValue::Number(report.node_load_count.to_string()),
        ),
        (
            "node_process_count",
            JsonValue::Number(report.node_process_count.to_string()),
        ),
        (
            "performance_eligible",
            JsonValue::Bool(report.performance_eligible),
        ),
        (
            "process_count",
            JsonValue::Number(report.process_count.to_string()),
        ),
        (
            "profile_digest",
            JsonValue::String(report.profile_digest.clone()),
        ),
        ("production_claim", JsonValue::Bool(report.production_claim)),
        ("release_build", JsonValue::Bool(report.release_build)),
        (
            "report_schema",
            JsonValue::String(report.report_schema.clone()),
        ),
        (
            "sample_schema",
            JsonValue::String(NODE_FREE_SAMPLE_SCHEMA.to_owned()),
        ),
        (
            "samples",
            JsonValue::Array(report.samples.iter().map(stable_sample_json).collect()),
        ),
        (
            "semantic_mismatch_count",
            JsonValue::Number(report.semantic_mismatch_count.to_string()),
        ),
        (
            "source_inventory_digest",
            JsonValue::String(report.source_inventory_digest.clone()),
        ),
        (
            "source_js_file_count",
            JsonValue::Number(report.source_js_file_count.to_string()),
        ),
        ("stable_v1_claim", JsonValue::Bool(report.stable_v1_claim)),
        (
            "toolchain_digest",
            JsonValue::String(report.toolchain_digest.clone()),
        ),
        (
            "workloads",
            JsonValue::Array(report.workloads.iter().map(workload_json).collect()),
        ),
    ])
}

fn evidence_json_without_digest(report: &NodeFreeReport) -> JsonValue {
    let mut fields = match stable_json(report) {
        JsonValue::Object(fields) => fields,
        JsonValue::Null
        | JsonValue::Bool(_)
        | JsonValue::Number(_)
        | JsonValue::String(_)
        | JsonValue::Array(_) => {
            unreachable!()
        }
    };
    fields.push((
        "timing_samples".to_owned(),
        JsonValue::Array(report.samples.iter().map(timing_sample_json).collect()),
    ));
    object(fields)
}

fn report_json(report: &NodeFreeReport) -> JsonValue {
    let mut fields = match evidence_json_without_digest(report) {
        JsonValue::Object(fields) => fields,
        JsonValue::Null
        | JsonValue::Bool(_)
        | JsonValue::Number(_)
        | JsonValue::String(_)
        | JsonValue::Array(_) => {
            unreachable!()
        }
    };
    fields.push((
        "evidence_digest".to_owned(),
        JsonValue::String(report.evidence_digest.clone()),
    ));
    fields.push((
        "stable_digest".to_owned(),
        JsonValue::String(report.stable_digest.clone()),
    ));
    object(fields)
}

fn workload_json(workload: &NativeWorkloadEvidence) -> JsonValue {
    object(vec![
        ("command", JsonValue::String(workload.command.clone())),
        (
            "exit_code",
            JsonValue::Number(workload.exit_code.to_string()),
        ),
        (
            "output_digest",
            JsonValue::String(workload.output_digest.clone()),
        ),
        (
            "semantic_digest",
            JsonValue::String(workload.semantic_digest.clone()),
        ),
        ("status", JsonValue::String(workload.status.clone())),
    ])
}

fn candidates_json(candidates: &[NativeCandidate]) -> JsonValue {
    JsonValue::Array(
        candidates
            .iter()
            .map(|candidate| {
                object(vec![
                    ("language", JsonValue::String(candidate.language.clone())),
                    ("reason", JsonValue::String(candidate.reason.clone())),
                    (
                        "sample_count",
                        JsonValue::Number(candidate.sample_count.to_string()),
                    ),
                    (
                        "semantic_mismatch_count",
                        JsonValue::Number(candidate.semantic_mismatch_count.to_string()),
                    ),
                    ("status", JsonValue::String(candidate.status.clone())),
                ])
            })
            .collect(),
    )
}

fn stable_sample_json(sample: &NativeSample) -> JsonValue {
    object(vec![
        ("round", JsonValue::Number(sample.round.to_string())),
        (
            "semantic_digest",
            JsonValue::String(sample.semantic_digest.clone()),
        ),
        (
            "workload_digest",
            JsonValue::String(sample.workload_digest.clone()),
        ),
    ])
}

fn timing_sample_json(sample: &NativeSample) -> JsonValue {
    object(vec![
        (
            "adapter_overhead_ns",
            JsonValue::Number(sample.adapter_overhead_ns.to_string()),
        ),
        (
            "cold_build_ns",
            JsonValue::Number(sample.cold_build_ns.to_string()),
        ),
        ("p50_ns", JsonValue::Number(sample.p50_ns.to_string())),
        ("p95_ns", JsonValue::Number(sample.p95_ns.to_string())),
        ("p99_ns", JsonValue::Number(sample.p99_ns.to_string())),
        (
            "peak_rss_bytes",
            JsonValue::Number(sample.peak_rss_bytes.to_string()),
        ),
        (
            "project_overhead_ns",
            JsonValue::Number(sample.project_overhead_ns.to_string()),
        ),
        ("round", JsonValue::Number(sample.round.to_string())),
        (
            "startup_ns",
            JsonValue::Number(sample.startup_ns.to_string()),
        ),
        (
            "throughput_ops_per_sec_milli",
            JsonValue::Number(sample.throughput_ops_per_sec_milli.to_string()),
        ),
        (
            "warm_build_ns",
            JsonValue::Number(sample.warm_build_ns.to_string()),
        ),
    ])
}

fn object<K: Into<String>>(fields: Vec<(K, JsonValue)>) -> JsonValue {
    JsonValue::Object(
        fields
            .into_iter()
            .map(|(key, value)| (key.into(), value))
            .collect(),
    )
}

fn digest_json(value: &JsonValue) -> String {
    format!("sha256:{}", sha256_hex(canonicalize(value).as_bytes()))
}

fn is_digest(value: &str) -> bool {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return false;
    };
    hex.len() == 64
        && hex
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}
