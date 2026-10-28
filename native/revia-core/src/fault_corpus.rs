use std::collections::{BTreeMap, BTreeSet};

use crate::{
    canonical_json::{JsonValue, canonicalize},
    digest::sha256_hex,
    graph::{check_graph, graph_revision, load_canonical_graph, parse_compact_graph},
    project::parse_json,
    replay::{parse_native_replay_transcript, serialize_native_replay_transcript},
    replay_fault_catalog::ReplayFaultKind,
};

pub const NATIVE_FAULT_CORPUS_SCHEMA: &str = "re.native-fault-corpus@0.1.0";
pub const NATIVE_FAULT_OBSERVATION_SCHEMA: &str = "re.native-fault-observation@0.1.0";
pub const NATIVE_FAULT_REPORT_SCHEMA: &str = "re.native-fault-observation-report@0.1.0";
pub const NATIVE_FAULT_RELEASE_EVIDENCE_SCHEMA: &str =
    "re.native-fault-corpus-release-evidence@0.1.0";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeFaultCorpusError {
    pub code: String,
}

impl NativeFaultCorpusError {
    fn new(code: &str) -> Self {
        Self {
            code: code.to_owned(),
        }
    }
}

impl From<crate::replay_fault_catalog::ReplayFaultCatalogError> for NativeFaultCorpusError {
    fn from(error: crate::replay_fault_catalog::ReplayFaultCatalogError) -> Self {
        Self { code: error.code }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FaultStage {
    CheckedError,
    ReplayMismatch,
    HostObservation,
}

impl FaultStage {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::CheckedError => "checked-error",
            Self::ReplayMismatch => "replay-mismatch",
            Self::HostObservation => "host-observation",
        }
    }

    fn parse(value: &str) -> Result<Self, NativeFaultCorpusError> {
        match value {
            "checked-error" => Ok(Self::CheckedError),
            "replay-mismatch" => Ok(Self::ReplayMismatch),
            "host-observation" => Ok(Self::HostObservation),
            _ => Err(NativeFaultCorpusError::new("native-fault-stage-invalid")),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FaultEvidenceScope {
    Exercised,
    Reachable,
}

impl FaultEvidenceScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Exercised => "exercised",
            Self::Reachable => "reachable",
        }
    }

    fn parse(value: &str) -> Result<Self, NativeFaultCorpusError> {
        match value {
            "exercised" => Ok(Self::Exercised),
            "reachable" => Ok(Self::Reachable),
            _ => Err(NativeFaultCorpusError::new(
                "native-fault-evidence-scope-invalid",
            )),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeFaultCorpusCase {
    pub case_id: String,
    pub source: String,
    pub input_digest: String,
    pub transcript: String,
    pub expected_stage: FaultStage,
    pub expected_kind: ReplayFaultKind,
    pub expected_code: String,
}

impl NativeFaultCorpusCase {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        case_id: impl Into<String>,
        source: impl Into<String>,
        input_digest: impl Into<String>,
        transcript: impl Into<String>,
        expected_stage: FaultStage,
        expected_kind: ReplayFaultKind,
        expected_code: impl Into<String>,
    ) -> Self {
        Self {
            case_id: case_id.into(),
            source: source.into(),
            input_digest: input_digest.into(),
            transcript: transcript.into(),
            expected_stage,
            expected_kind,
            expected_code: expected_code.into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeFaultCorpus {
    pub schema: String,
    pub cases: Vec<NativeFaultCorpusCase>,
}

impl NativeFaultCorpus {
    pub fn new(cases: Vec<NativeFaultCorpusCase>) -> Self {
        Self {
            schema: NATIVE_FAULT_CORPUS_SCHEMA.to_owned(),
            cases,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeFaultObservation {
    pub schema: String,
    pub backend: String,
    pub case_id: String,
    pub stage: FaultStage,
    pub kind: ReplayFaultKind,
    pub code: String,
    pub graph_revision: Option<String>,
    pub source_digest: String,
    pub input_digest: String,
    pub transcript_digest: String,
    pub evidence_scope: FaultEvidenceScope,
    pub receipt_digest: Option<String>,
    pub semantic_digest: String,
    pub observation_digest: String,
    pub status: String,
}

impl NativeFaultObservation {
    #[allow(clippy::too_many_arguments)]
    pub fn measured(
        case_id: impl Into<String>,
        source: &str,
        graph_revision: Option<&str>,
        input_digest: impl Into<String>,
        transcript: &str,
        stage: FaultStage,
        kind: ReplayFaultKind,
        code: impl Into<String>,
        evidence_scope: FaultEvidenceScope,
    ) -> Self {
        let mut observation = Self {
            schema: NATIVE_FAULT_OBSERVATION_SCHEMA.to_owned(),
            backend: "native".to_owned(),
            case_id: case_id.into(),
            stage,
            kind,
            code: code.into(),
            graph_revision: graph_revision.map(str::to_owned),
            source_digest: digest_bytes(source.as_bytes()),
            input_digest: input_digest.into(),
            transcript_digest: digest_bytes(transcript.as_bytes()),
            evidence_scope,
            receipt_digest: None,
            semantic_digest: String::new(),
            observation_digest: String::new(),
            status: "measured".to_owned(),
        };
        observation.semantic_digest = semantic_digest(&observation);
        observation.observation_digest = observation_digest(&observation);
        observation
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeFaultPendingBackend {
    pub backend: String,
    pub reason: String,
}

impl NativeFaultPendingBackend {
    pub fn new(backend: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            backend: backend.into(),
            reason: reason.into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeFaultCorpusReport {
    pub schema: String,
    pub corpus_digest: String,
    pub observations: Vec<NativeFaultObservation>,
    pub pending: Vec<NativeFaultPendingBackend>,
    pub status: String,
    pub report_digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeFaultEvidenceCase {
    pub case_id: String,
    pub graph_revision: Option<String>,
    pub observation_digest: String,
    pub source_digest: String,
    pub transcript_digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeFaultCorpusReleaseEvidence {
    pub schema: String,
    pub backend: String,
    pub binary_digest: String,
    pub corpus_digest: String,
    pub report_digest: String,
    pub toolchain_digest: String,
    pub release_build: bool,
    pub empty_path: bool,
    pub process_count: u32,
    pub node_process_count: u32,
    pub node_load_count: u32,
    pub node_import_count: u32,
    pub cases: Vec<NativeFaultEvidenceCase>,
    pub status: String,
    pub stable_digest: String,
    pub evidence_digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeFaultReleaseRun {
    pub binary_digest: String,
    pub toolchain_digest: String,
    pub release_build: bool,
    pub empty_path: bool,
    pub process_count: u32,
    pub node_process_count: u32,
    pub node_load_count: u32,
    pub node_import_count: u32,
}

pub fn build_native_fault_corpus_release_evidence(
    corpus: &NativeFaultCorpus,
    report: &NativeFaultCorpusReport,
    run: NativeFaultReleaseRun,
) -> Result<NativeFaultCorpusReleaseEvidence, NativeFaultCorpusError> {
    validate_corpus(corpus)?;
    validate_release_report_authority(corpus, report)?;
    let mut evidence = NativeFaultCorpusReleaseEvidence {
        schema: NATIVE_FAULT_RELEASE_EVIDENCE_SCHEMA.to_owned(),
        backend: "native".to_owned(),
        binary_digest: run.binary_digest,
        corpus_digest: corpus_digest(corpus)?,
        report_digest: report.report_digest.clone(),
        toolchain_digest: run.toolchain_digest,
        release_build: run.release_build,
        empty_path: run.empty_path,
        process_count: run.process_count,
        node_process_count: run.node_process_count,
        node_load_count: run.node_load_count,
        node_import_count: run.node_import_count,
        cases: report
            .observations
            .iter()
            .map(|observation| NativeFaultEvidenceCase {
                case_id: observation.case_id.clone(),
                graph_revision: observation.graph_revision.clone(),
                observation_digest: observation.observation_digest.clone(),
                source_digest: observation.source_digest.clone(),
                transcript_digest: observation.transcript_digest.clone(),
            })
            .collect(),
        status: "measured".to_owned(),
        stable_digest: String::new(),
        evidence_digest: String::new(),
    };
    evidence.stable_digest = release_stable_digest(&evidence);
    evidence.evidence_digest = release_evidence_digest(&evidence);
    validate_native_fault_corpus_release_evidence(corpus, report, &evidence)?;
    Ok(evidence)
}

pub fn validate_native_fault_corpus_release_evidence(
    corpus: &NativeFaultCorpus,
    report: &NativeFaultCorpusReport,
    evidence: &NativeFaultCorpusReleaseEvidence,
) -> Result<(), NativeFaultCorpusError> {
    validate_corpus(corpus)?;
    validate_release_report_authority(corpus, report)?;
    if evidence.schema != NATIVE_FAULT_RELEASE_EVIDENCE_SCHEMA
        || evidence.backend != "native"
        || evidence.status != "measured"
        || !evidence.release_build
        || !evidence.empty_path
        || evidence.process_count == 0
        || evidence.node_process_count != 0
        || evidence.node_load_count != 0
        || evidence.node_import_count != 0
        || !is_digest(&evidence.binary_digest)
        || !is_digest(&evidence.corpus_digest)
        || !is_digest(&evidence.report_digest)
        || !is_digest(&evidence.toolchain_digest)
    {
        return Err(NativeFaultCorpusError::new(
            "native-fault-release-evidence-authority-invalid",
        ));
    }
    if evidence.corpus_digest != corpus_digest(corpus)?
        || evidence.report_digest != report.report_digest
    {
        return Err(NativeFaultCorpusError::new(
            "native-fault-release-evidence-report-authority-mismatch",
        ));
    }
    if evidence.cases.len() != report.observations.len() {
        return Err(NativeFaultCorpusError::new(
            "native-fault-release-evidence-case-set-invalid",
        ));
    }
    for (case, observation) in evidence.cases.iter().zip(&report.observations) {
        if !valid_id(&case.case_id)
            || case.case_id != observation.case_id
            || case.graph_revision != observation.graph_revision
            || case.observation_digest != observation.observation_digest
            || case.source_digest != observation.source_digest
            || case.transcript_digest != observation.transcript_digest
        {
            return Err(NativeFaultCorpusError::new(
                "native-fault-release-evidence-case-authority-mismatch",
            ));
        }
    }
    if evidence.stable_digest != release_stable_digest(evidence) {
        return Err(NativeFaultCorpusError::new(
            "native-fault-release-evidence-stable-digest-mismatch",
        ));
    }
    if evidence.evidence_digest != release_evidence_digest(evidence) {
        return Err(NativeFaultCorpusError::new(
            "native-fault-release-evidence-digest-mismatch",
        ));
    }
    Ok(())
}

fn validate_release_report_authority(
    corpus: &NativeFaultCorpus,
    report: &NativeFaultCorpusReport,
) -> Result<(), NativeFaultCorpusError> {
    validate_report_content(corpus, report)?;
    if report.corpus_digest != corpus_digest(corpus)?
        || report.report_digest != report_digest(report)?
    {
        return Err(NativeFaultCorpusError::new(
            "native-fault-release-evidence-report-authority-invalid",
        ));
    }
    Ok(())
}

pub fn serialize_native_fault_corpus_release_evidence(
    corpus: &NativeFaultCorpus,
    report: &NativeFaultCorpusReport,
    evidence: &NativeFaultCorpusReleaseEvidence,
) -> Result<String, NativeFaultCorpusError> {
    validate_native_fault_corpus_release_evidence(corpus, report, evidence)?;
    Ok(format!(
        "{}\n",
        canonicalize(&release_evidence_json(evidence, true))
    ))
}

pub fn parse_native_fault_corpus_release_evidence(
    source: &str,
) -> Result<NativeFaultCorpusReleaseEvidence, NativeFaultCorpusError> {
    let value = parse_json(source)
        .map_err(|_| NativeFaultCorpusError::new("native-fault-release-evidence-json-invalid"))?;
    let entries = exact_object(
        &value,
        &[
            "backend",
            "binary_digest",
            "cases",
            "corpus_digest",
            "empty_path",
            "evidence_digest",
            "node_import_count",
            "node_load_count",
            "node_process_count",
            "process_count",
            "release_build",
            "report_digest",
            "schema",
            "stable_digest",
            "status",
            "toolchain_digest",
        ],
    )?;
    let cases = match entries.get("cases") {
        Some(JsonValue::Array(values)) => values
            .iter()
            .map(parse_evidence_case)
            .collect::<Result<Vec<_>, _>>()?,
        _ => {
            return Err(NativeFaultCorpusError::new(
                "native-fault-release-evidence-cases-invalid",
            ));
        }
    };
    let evidence = NativeFaultCorpusReleaseEvidence {
        schema: required_string(&entries, "schema")?.to_owned(),
        backend: required_string(&entries, "backend")?.to_owned(),
        binary_digest: required_string(&entries, "binary_digest")?.to_owned(),
        corpus_digest: required_string(&entries, "corpus_digest")?.to_owned(),
        report_digest: required_string(&entries, "report_digest")?.to_owned(),
        toolchain_digest: required_string(&entries, "toolchain_digest")?.to_owned(),
        release_build: required_bool(&entries, "release_build")?,
        empty_path: required_bool(&entries, "empty_path")?,
        process_count: required_u32(&entries, "process_count")?,
        node_process_count: required_u32(&entries, "node_process_count")?,
        node_load_count: required_u32(&entries, "node_load_count")?,
        node_import_count: required_u32(&entries, "node_import_count")?,
        cases,
        status: required_string(&entries, "status")?.to_owned(),
        stable_digest: required_string(&entries, "stable_digest")?.to_owned(),
        evidence_digest: required_string(&entries, "evidence_digest")?.to_owned(),
    };
    if evidence.schema != NATIVE_FAULT_RELEASE_EVIDENCE_SCHEMA
        || evidence.status != "measured"
        || evidence.evidence_digest != release_evidence_digest(&evidence)
        || evidence.stable_digest != release_stable_digest(&evidence)
        || format!(
            "{}\n",
            canonicalize(&release_evidence_json(&evidence, true))
        ) != source
    {
        return Err(NativeFaultCorpusError::new(
            "native-fault-release-evidence-non-canonical",
        ));
    }
    Ok(evidence)
}

pub fn build_native_fault_corpus_report(
    corpus: &NativeFaultCorpus,
    observations: Vec<NativeFaultObservation>,
    pending: Vec<NativeFaultPendingBackend>,
) -> Result<NativeFaultCorpusReport, NativeFaultCorpusError> {
    validate_corpus(corpus)?;
    let mut report = NativeFaultCorpusReport {
        schema: NATIVE_FAULT_REPORT_SCHEMA.to_owned(),
        corpus_digest: corpus_digest(corpus)?,
        observations,
        pending,
        status: "measured".to_owned(),
        report_digest: String::new(),
    };
    validate_report_content(corpus, &report)?;
    report.report_digest = report_digest(&report)?;
    validate_native_fault_corpus_report(corpus, &report)?;
    Ok(report)
}

pub fn validate_native_fault_corpus_report(
    corpus: &NativeFaultCorpus,
    report: &NativeFaultCorpusReport,
) -> Result<(), NativeFaultCorpusError> {
    validate_report_content(corpus, report)?;
    if report.corpus_digest != corpus_digest(corpus)? {
        return Err(NativeFaultCorpusError::new(
            "native-fault-report-corpus-digest-mismatch",
        ));
    }
    if report.report_digest != report_digest(report)? {
        return Err(NativeFaultCorpusError::new(
            "native-fault-report-digest-mismatch",
        ));
    }
    Ok(())
}

pub fn serialize_native_fault_corpus(
    corpus: &NativeFaultCorpus,
) -> Result<String, NativeFaultCorpusError> {
    validate_corpus(corpus)?;
    Ok(format!("{}\n", canonicalize(&corpus_json(corpus)?)))
}

pub fn parse_native_fault_corpus(
    source: &str,
) -> Result<NativeFaultCorpus, NativeFaultCorpusError> {
    let value = parse_json(source)
        .map_err(|_| NativeFaultCorpusError::new("native-fault-corpus-json-invalid"))?;
    let entries = exact_object(&value, &["cases", "schema"])?;
    let cases = match entries.get("cases") {
        Some(JsonValue::Array(values)) => values
            .iter()
            .map(parse_case)
            .collect::<Result<Vec<_>, _>>()?,
        _ => {
            return Err(NativeFaultCorpusError::new(
                "native-fault-corpus-cases-invalid",
            ));
        }
    };
    let corpus = NativeFaultCorpus {
        schema: required_string(&entries, "schema")?.to_owned(),
        cases,
    };
    validate_corpus(&corpus)?;
    if serialize_native_fault_corpus(&corpus)? != source {
        return Err(NativeFaultCorpusError::new(
            "native-fault-corpus-non-canonical-source",
        ));
    }
    Ok(corpus)
}

pub fn serialize_native_fault_corpus_report(
    report: &NativeFaultCorpusReport,
) -> Result<String, NativeFaultCorpusError> {
    if report.schema != NATIVE_FAULT_REPORT_SCHEMA
        || report.status != "measured"
        || report.report_digest != report_digest(report)?
    {
        return Err(NativeFaultCorpusError::new(
            "native-fault-report-authority-invalid",
        ));
    }
    Ok(format!("{}\n", canonicalize(&report_json(report, true)?)))
}

pub fn parse_native_fault_corpus_report(
    source: &str,
) -> Result<NativeFaultCorpusReport, NativeFaultCorpusError> {
    let value = parse_json(source)
        .map_err(|_| NativeFaultCorpusError::new("native-fault-report-json-invalid"))?;
    let entries = exact_object(
        &value,
        &[
            "corpus_digest",
            "observations",
            "pending",
            "report_digest",
            "schema",
            "status",
        ],
    )?;
    let observations = match entries.get("observations") {
        Some(JsonValue::Array(values)) => values
            .iter()
            .map(parse_observation)
            .collect::<Result<Vec<_>, _>>()?,
        _ => {
            return Err(NativeFaultCorpusError::new(
                "native-fault-report-observations-invalid",
            ));
        }
    };
    let pending = match entries.get("pending") {
        Some(JsonValue::Array(values)) => values
            .iter()
            .map(parse_pending)
            .collect::<Result<Vec<_>, _>>()?,
        _ => {
            return Err(NativeFaultCorpusError::new(
                "native-fault-report-pending-invalid",
            ));
        }
    };
    let report = NativeFaultCorpusReport {
        schema: required_string(&entries, "schema")?.to_owned(),
        corpus_digest: required_string(&entries, "corpus_digest")?.to_owned(),
        observations,
        pending,
        status: required_string(&entries, "status")?.to_owned(),
        report_digest: required_string(&entries, "report_digest")?.to_owned(),
    };
    if report.schema != NATIVE_FAULT_REPORT_SCHEMA || report.status != "measured" {
        return Err(NativeFaultCorpusError::new(
            "native-fault-report-authority-invalid",
        ));
    }
    if report.report_digest != report_digest(&report)? {
        return Err(NativeFaultCorpusError::new(
            "native-fault-report-digest-mismatch",
        ));
    }
    if serialize_native_fault_corpus_report(&report)? != source {
        return Err(NativeFaultCorpusError::new(
            "native-fault-report-non-canonical-source",
        ));
    }
    Ok(report)
}

fn validate_corpus(corpus: &NativeFaultCorpus) -> Result<(), NativeFaultCorpusError> {
    if corpus.schema != NATIVE_FAULT_CORPUS_SCHEMA || corpus.cases.len() < 5 {
        return Err(NativeFaultCorpusError::new(
            "native-fault-corpus-schema-or-size-invalid",
        ));
    }
    let mut ids = BTreeSet::new();
    for case in &corpus.cases {
        if !valid_id(&case.case_id)
            || !ids.insert(case.case_id.clone())
            || case.expected_code.is_empty()
            || !is_digest(&case.input_digest)
            || !(case.source.starts_with("re 0.1 ") || case.source.starts_with("re 1.0 "))
            || case.source.contains('\0')
        {
            return Err(NativeFaultCorpusError::new(
                "native-fault-corpus-case-invalid",
            ));
        }
        let transcript = parse_native_replay_transcript(&case.transcript)
            .map_err(|_| NativeFaultCorpusError::new("native-fault-corpus-transcript-invalid"))?;
        if serialize_native_replay_transcript(&transcript)
            .map_err(|_| NativeFaultCorpusError::new("native-fault-corpus-transcript-invalid"))?
            != case.transcript
        {
            return Err(NativeFaultCorpusError::new(
                "native-fault-corpus-transcript-non-canonical",
            ));
        }
        if case.expected_stage == FaultStage::ReplayMismatch
            && case.expected_kind != ReplayFaultKind::ReplayMismatch
        {
            return Err(NativeFaultCorpusError::new(
                "native-fault-corpus-stage-kind-mismatch",
            ));
        }
        if case.expected_stage == FaultStage::CheckedError
            && case.expected_kind != ReplayFaultKind::CheckFailure
        {
            return Err(NativeFaultCorpusError::new(
                "native-fault-corpus-stage-kind-mismatch",
            ));
        }
        if case.expected_stage == FaultStage::HostObservation
            && case.expected_kind != ReplayFaultKind::HostFault
        {
            return Err(NativeFaultCorpusError::new(
                "native-fault-corpus-stage-kind-mismatch",
            ));
        }
    }
    Ok(())
}

fn validate_report_content(
    corpus: &NativeFaultCorpus,
    report: &NativeFaultCorpusReport,
) -> Result<(), NativeFaultCorpusError> {
    if report.schema != NATIVE_FAULT_REPORT_SCHEMA
        || report.status != "measured"
        || report.observations.len() != corpus.cases.len()
    {
        return Err(NativeFaultCorpusError::new(
            "native-fault-report-content-invalid",
        ));
    }
    validate_pending(&report.pending)?;
    for (case, observation) in corpus.cases.iter().zip(&report.observations) {
        let source_graph_revision = source_graph_revision(&case.source);
        if observation.backend != "native"
            || observation.case_id != case.case_id
            || observation.source_digest != digest_bytes(case.source.as_bytes())
            || observation.input_digest != case.input_digest
            || observation.transcript_digest != digest_bytes(case.transcript.as_bytes())
            || observation.stage != case.expected_stage
            || observation.kind != case.expected_kind
            || observation.code != case.expected_code
            || observation.evidence_scope != FaultEvidenceScope::Exercised
            || observation.receipt_digest.is_some()
            || observation.status != "measured"
            || observation.graph_revision != source_graph_revision
            || observation.semantic_digest != semantic_digest(observation)
            || observation.observation_digest != observation_digest(observation)
        {
            return Err(NativeFaultCorpusError::new(
                "native-fault-report-observation-mismatch",
            ));
        }
    }
    Ok(())
}

fn source_graph_revision(source: &str) -> Option<String> {
    let graph = if source.starts_with("re 0.1 canonical\n") {
        load_canonical_graph(source).ok()?
    } else {
        parse_compact_graph(source, "native-fault-corpus").ok()?
    };
    let graph = check_graph(graph).ok()?;
    graph_revision(&graph).ok()
}

fn validate_pending(pending: &[NativeFaultPendingBackend]) -> Result<(), NativeFaultCorpusError> {
    if pending.len() != 3
        || pending
            .iter()
            .map(|item| item.backend.as_str())
            .collect::<Vec<_>>()
            != ["node", "go", "jvm"]
        || pending
            .iter()
            .any(|item| item.reason.is_empty() || item.backend == "native")
    {
        return Err(NativeFaultCorpusError::new(
            "native-fault-report-pending-partition-invalid",
        ));
    }
    Ok(())
}

fn parse_case(value: &JsonValue) -> Result<NativeFaultCorpusCase, NativeFaultCorpusError> {
    let entries = exact_object(
        value,
        &[
            "expected_code",
            "expected_kind",
            "expected_stage",
            "input_digest",
            "source",
            "transcript",
            "case_id",
        ],
    )?;
    Ok(NativeFaultCorpusCase::new(
        required_string(&entries, "case_id")?,
        required_string(&entries, "source")?,
        required_string(&entries, "input_digest")?,
        required_string(&entries, "transcript")?,
        FaultStage::parse(required_string(&entries, "expected_stage")?)?,
        ReplayFaultKind::parse(required_string(&entries, "expected_kind")?)?,
        required_string(&entries, "expected_code")?,
    ))
}

fn parse_observation(value: &JsonValue) -> Result<NativeFaultObservation, NativeFaultCorpusError> {
    let entries = exact_object(
        value,
        &[
            "backend",
            "case_id",
            "code",
            "evidence_scope",
            "graph_revision",
            "input_digest",
            "kind",
            "observation_digest",
            "schema",
            "semantic_digest",
            "source_digest",
            "stage",
            "status",
            "transcript_digest",
        ],
    )?;
    let graph_revision = match entries.get("graph_revision") {
        Some(JsonValue::Null) => None,
        Some(JsonValue::String(value)) => Some(value.clone()),
        _ => {
            return Err(NativeFaultCorpusError::new(
                "native-fault-observation-authority-invalid",
            ));
        }
    };
    let observation = NativeFaultObservation {
        schema: required_string(&entries, "schema")?.to_owned(),
        backend: required_string(&entries, "backend")?.to_owned(),
        case_id: required_string(&entries, "case_id")?.to_owned(),
        stage: FaultStage::parse(required_string(&entries, "stage")?)?,
        kind: ReplayFaultKind::parse(required_string(&entries, "kind")?)?,
        code: required_string(&entries, "code")?.to_owned(),
        graph_revision,
        source_digest: required_string(&entries, "source_digest")?.to_owned(),
        input_digest: required_string(&entries, "input_digest")?.to_owned(),
        transcript_digest: required_string(&entries, "transcript_digest")?.to_owned(),
        evidence_scope: FaultEvidenceScope::parse(required_string(&entries, "evidence_scope")?)?,
        receipt_digest: None,
        semantic_digest: required_string(&entries, "semantic_digest")?.to_owned(),
        observation_digest: required_string(&entries, "observation_digest")?.to_owned(),
        status: required_string(&entries, "status")?.to_owned(),
    };
    if observation.evidence_scope != FaultEvidenceScope::Exercised {
        return Err(NativeFaultCorpusError::new(
            "native-fault-observation-not-exercised",
        ));
    }
    if observation.schema != NATIVE_FAULT_OBSERVATION_SCHEMA {
        return Err(NativeFaultCorpusError::new(
            "native-fault-observation-schema-mismatch",
        ));
    }
    if observation.receipt_digest.is_some() {
        return Err(NativeFaultCorpusError::new(
            "native-fault-observation-receipt-forbidden",
        ));
    }
    if observation.observation_digest != observation_digest(&observation) {
        return Err(NativeFaultCorpusError::new(
            "native-fault-observation-digest-mismatch",
        ));
    }
    Ok(observation)
}

fn parse_pending(value: &JsonValue) -> Result<NativeFaultPendingBackend, NativeFaultCorpusError> {
    let entries = exact_object(value, &["backend", "reason"])?;
    Ok(NativeFaultPendingBackend::new(
        required_string(&entries, "backend")?,
        required_string(&entries, "reason")?,
    ))
}

fn corpus_digest(corpus: &NativeFaultCorpus) -> Result<String, NativeFaultCorpusError> {
    Ok(digest_json(&corpus_json(corpus)?))
}

fn report_digest(report: &NativeFaultCorpusReport) -> Result<String, NativeFaultCorpusError> {
    Ok(digest_json(&report_json(report, false)?))
}

fn semantic_digest(observation: &NativeFaultObservation) -> String {
    digest_json(&object(vec![
        ("code", JsonValue::String(observation.code.clone())),
        (
            "kind",
            JsonValue::String(observation.kind.as_str().to_owned()),
        ),
        (
            "stage",
            JsonValue::String(observation.stage.as_str().to_owned()),
        ),
    ]))
}

fn observation_digest(observation: &NativeFaultObservation) -> String {
    digest_json(&observation_json(observation, false))
}

fn corpus_json(corpus: &NativeFaultCorpus) -> Result<JsonValue, NativeFaultCorpusError> {
    Ok(object(vec![
        (
            "cases",
            JsonValue::Array(corpus.cases.iter().map(case_json).collect()),
        ),
        ("schema", JsonValue::String(corpus.schema.clone())),
    ]))
}

fn case_json(case: &NativeFaultCorpusCase) -> JsonValue {
    object(vec![
        ("case_id", JsonValue::String(case.case_id.clone())),
        (
            "expected_code",
            JsonValue::String(case.expected_code.clone()),
        ),
        (
            "expected_kind",
            JsonValue::String(case.expected_kind.as_str().to_owned()),
        ),
        (
            "expected_stage",
            JsonValue::String(case.expected_stage.as_str().to_owned()),
        ),
        ("input_digest", JsonValue::String(case.input_digest.clone())),
        ("source", JsonValue::String(case.source.clone())),
        ("transcript", JsonValue::String(case.transcript.clone())),
    ])
}

fn report_json(
    report: &NativeFaultCorpusReport,
    include_digest: bool,
) -> Result<JsonValue, NativeFaultCorpusError> {
    let mut fields = vec![
        (
            "corpus_digest",
            JsonValue::String(report.corpus_digest.clone()),
        ),
        (
            "observations",
            JsonValue::Array(
                report
                    .observations
                    .iter()
                    .map(|item| observation_json(item, true))
                    .collect(),
            ),
        ),
        (
            "pending",
            JsonValue::Array(
                report
                    .pending
                    .iter()
                    .map(|item| {
                        object(vec![
                            ("backend", JsonValue::String(item.backend.clone())),
                            ("reason", JsonValue::String(item.reason.clone())),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "report_digest",
            if include_digest {
                JsonValue::String(report.report_digest.clone())
            } else {
                JsonValue::Null
            },
        ),
        ("schema", JsonValue::String(report.schema.clone())),
        ("status", JsonValue::String(report.status.clone())),
    ];
    if !include_digest {
        fields.retain(|(key, _)| *key != "report_digest");
    }
    Ok(object(fields))
}

fn observation_json(observation: &NativeFaultObservation, include_digest: bool) -> JsonValue {
    let mut fields = vec![
        ("backend", JsonValue::String(observation.backend.clone())),
        ("case_id", JsonValue::String(observation.case_id.clone())),
        ("code", JsonValue::String(observation.code.clone())),
        (
            "evidence_scope",
            JsonValue::String(observation.evidence_scope.as_str().to_owned()),
        ),
        (
            "graph_revision",
            observation
                .graph_revision
                .as_ref()
                .map(|value| JsonValue::String(value.clone()))
                .unwrap_or(JsonValue::Null),
        ),
        (
            "input_digest",
            JsonValue::String(observation.input_digest.clone()),
        ),
        (
            "kind",
            JsonValue::String(observation.kind.as_str().to_owned()),
        ),
        (
            "observation_digest",
            if include_digest {
                JsonValue::String(observation.observation_digest.clone())
            } else {
                JsonValue::Null
            },
        ),
        ("schema", JsonValue::String(observation.schema.clone())),
        (
            "semantic_digest",
            JsonValue::String(observation.semantic_digest.clone()),
        ),
        (
            "source_digest",
            JsonValue::String(observation.source_digest.clone()),
        ),
        (
            "stage",
            JsonValue::String(observation.stage.as_str().to_owned()),
        ),
        ("status", JsonValue::String(observation.status.clone())),
        (
            "transcript_digest",
            JsonValue::String(observation.transcript_digest.clone()),
        ),
    ];
    if !include_digest {
        fields.retain(|(key, _)| *key != "observation_digest");
    }
    object(fields)
}

fn digest_json(value: &JsonValue) -> String {
    digest_bytes(canonicalize(value).as_bytes())
}

fn digest_bytes(bytes: &[u8]) -> String {
    format!("sha256:{}", sha256_hex(bytes))
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

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn object(fields: Vec<(&str, JsonValue)>) -> JsonValue {
    JsonValue::Object(
        fields
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value))
            .collect(),
    )
}

fn exact_object<'a>(
    value: &'a JsonValue,
    expected: &[&str],
) -> Result<BTreeMap<String, &'a JsonValue>, NativeFaultCorpusError> {
    let JsonValue::Object(entries) = value else {
        return Err(NativeFaultCorpusError::new("native-fault-object-invalid"));
    };
    let expected = expected.iter().copied().collect::<BTreeSet<_>>();
    let mut result = BTreeMap::new();
    for (key, value) in entries {
        if !expected.contains(key.as_str()) {
            return Err(NativeFaultCorpusError::new("native-fault-unexpected-field"));
        }
        if result.insert(key.clone(), value).is_some() {
            return Err(NativeFaultCorpusError::new("native-fault-duplicate-field"));
        }
    }
    if result.len() != expected.len() {
        return Err(NativeFaultCorpusError::new(
            "native-fault-required-field-missing",
        ));
    }
    Ok(result)
}

fn required_string<'a>(
    entries: &BTreeMap<String, &'a JsonValue>,
    name: &str,
) -> Result<&'a str, NativeFaultCorpusError> {
    match entries.get(name) {
        Some(JsonValue::String(value)) => Ok(value),
        _ => Err(NativeFaultCorpusError::new("native-fault-field-invalid")),
    }
}

fn required_bool(
    entries: &BTreeMap<String, &JsonValue>,
    name: &str,
) -> Result<bool, NativeFaultCorpusError> {
    match entries.get(name) {
        Some(JsonValue::Bool(value)) => Ok(*value),
        _ => Err(NativeFaultCorpusError::new("native-fault-field-invalid")),
    }
}

fn required_u32(
    entries: &BTreeMap<String, &JsonValue>,
    name: &str,
) -> Result<u32, NativeFaultCorpusError> {
    match entries.get(name) {
        Some(JsonValue::Number(value)) => value
            .parse::<u32>()
            .map_err(|_| NativeFaultCorpusError::new("native-fault-field-invalid")),
        _ => Err(NativeFaultCorpusError::new("native-fault-field-invalid")),
    }
}

fn parse_evidence_case(
    value: &JsonValue,
) -> Result<NativeFaultEvidenceCase, NativeFaultCorpusError> {
    let entries = exact_object(
        value,
        &[
            "case_id",
            "graph_revision",
            "observation_digest",
            "source_digest",
            "transcript_digest",
        ],
    )?;
    let graph_revision = match entries.get("graph_revision") {
        Some(JsonValue::Null) => None,
        Some(JsonValue::String(value)) => Some(value.clone()),
        _ => {
            return Err(NativeFaultCorpusError::new(
                "native-fault-release-evidence-case-invalid",
            ));
        }
    };
    Ok(NativeFaultEvidenceCase {
        case_id: required_string(&entries, "case_id")?.to_owned(),
        graph_revision,
        observation_digest: required_string(&entries, "observation_digest")?.to_owned(),
        source_digest: required_string(&entries, "source_digest")?.to_owned(),
        transcript_digest: required_string(&entries, "transcript_digest")?.to_owned(),
    })
}

fn release_stable_digest(evidence: &NativeFaultCorpusReleaseEvidence) -> String {
    digest_json(&release_evidence_json(evidence, false))
}

fn release_evidence_digest(evidence: &NativeFaultCorpusReleaseEvidence) -> String {
    let mut fields = match release_evidence_json(evidence, true) {
        JsonValue::Object(fields) => fields,
        JsonValue::Null
        | JsonValue::Bool(_)
        | JsonValue::Number(_)
        | JsonValue::String(_)
        | JsonValue::Array(_) => unreachable!(),
    };
    fields.retain(|(key, _)| key != "evidence_digest");
    digest_json(&JsonValue::Object(fields))
}

fn release_evidence_json(
    evidence: &NativeFaultCorpusReleaseEvidence,
    include_digests: bool,
) -> JsonValue {
    let mut fields = vec![
        ("backend", JsonValue::String(evidence.backend.clone())),
        (
            "binary_digest",
            JsonValue::String(evidence.binary_digest.clone()),
        ),
        (
            "cases",
            JsonValue::Array(
                evidence
                    .cases
                    .iter()
                    .map(|case| {
                        object(vec![
                            ("case_id", JsonValue::String(case.case_id.clone())),
                            (
                                "graph_revision",
                                case.graph_revision
                                    .as_ref()
                                    .map(|value| JsonValue::String(value.clone()))
                                    .unwrap_or(JsonValue::Null),
                            ),
                            (
                                "observation_digest",
                                JsonValue::String(case.observation_digest.clone()),
                            ),
                            (
                                "source_digest",
                                JsonValue::String(case.source_digest.clone()),
                            ),
                            (
                                "transcript_digest",
                                JsonValue::String(case.transcript_digest.clone()),
                            ),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "corpus_digest",
            JsonValue::String(evidence.corpus_digest.clone()),
        ),
        ("empty_path", JsonValue::Bool(evidence.empty_path)),
        (
            "evidence_digest",
            JsonValue::String(evidence.evidence_digest.clone()),
        ),
        (
            "node_import_count",
            JsonValue::Number(evidence.node_import_count.to_string()),
        ),
        (
            "node_load_count",
            JsonValue::Number(evidence.node_load_count.to_string()),
        ),
        (
            "node_process_count",
            JsonValue::Number(evidence.node_process_count.to_string()),
        ),
        (
            "process_count",
            JsonValue::Number(evidence.process_count.to_string()),
        ),
        ("release_build", JsonValue::Bool(evidence.release_build)),
        (
            "report_digest",
            JsonValue::String(evidence.report_digest.clone()),
        ),
        ("schema", JsonValue::String(evidence.schema.clone())),
        (
            "stable_digest",
            JsonValue::String(evidence.stable_digest.clone()),
        ),
        ("status", JsonValue::String(evidence.status.clone())),
        (
            "toolchain_digest",
            JsonValue::String(evidence.toolchain_digest.clone()),
        ),
    ];
    if !include_digests {
        fields.retain(|(key, _)| *key != "evidence_digest" && *key != "stable_digest");
    }
    object(fields)
}
