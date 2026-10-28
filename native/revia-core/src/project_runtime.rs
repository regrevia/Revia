use std::{
    collections::BTreeSet,
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
};

use crate::{
    bytecode::{BytecodeArtifact, serialize_bytecode_artifact, translate_graph},
    canonical_json::{JsonValue, canonicalize},
    digest::sha256_hex,
    graph::{Graph, check_graph, load_canonical_graph, parse_compact_graph},
    project::{
        NativeBuildResult, NativeExport, NativeProject, NativeProjectModuleLoaded, build_project,
        exact_object, load_project_directory, parse_json, string,
    },
    source::SourceText,
    vm::{
        CapabilityBridge, NATIVE_VM_PROFILE, VmLimits, VmRequest, VmResult, VmValue,
        execute_bytecode_with_input_value, execute_bytecode_with_return_value, serialize_vm_value,
        vm_value_digest, vm_value_type_name,
    },
};

pub const PROJECT_TRANSLATION_SCHEMA: &str = "re.native-project-translation@0.1.0";
pub const PROJECT_RUN_SCHEMA: &str = "re.native-project-run@0.1.0";
pub const PROJECT_EXECUTION_PLAN_SCHEMA: &str = "re.native-project-execution-plan@0.1.0";
pub const PROJECT_EXECUTION_SCHEMA: &str = "re.native-project-execution@0.1.0";
pub const PROJECT_EXECUTION_ARTIFACT_CACHE_SCHEMA: &str =
    "re.native-project-execution-artifact-cache@0.1.0";
static EXECUTION_CACHE_NONCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectRuntimeError {
    pub code: String,
}

impl ProjectRuntimeError {
    pub(crate) fn new(code: &str) -> Self {
        Self {
            code: code.to_owned(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeProjectTranslation {
    pub artifact_digest: String,
    pub artifact_source: String,
    pub build_key: String,
    pub build_manifest_digest: String,
    pub graph_revision: String,
    pub module_artifact_digest: String,
    pub module_cache_key: String,
    pub module: String,
    pub entry: String,
    pub profile: String,
    pub profile_digest: String,
    pub project_graph_revision: String,
    pub project_digest: String,
    pub schema: String,
    pub toolchain_digest: String,
    pub translation_digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeProjectRun {
    pub build_key: String,
    pub graph_revision: String,
    pub input_digest: String,
    pub module: String,
    pub project_digest: String,
    pub run_digest: String,
    pub schema: String,
    pub translation: NativeProjectTranslation,
    pub vm: VmResult,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeProjectExecutionStep {
    pub binding: String,
    pub contract_digest: String,
    pub entry: String,
    pub handoff: Option<NativeProjectHandoff>,
    pub interface_digest: String,
    pub module: String,
}

impl NativeProjectExecutionStep {
    pub fn new(
        binding: impl Into<String>,
        module: impl Into<String>,
        entry: impl Into<String>,
        interface_digest: impl Into<String>,
        contract_digest: impl Into<String>,
    ) -> Self {
        Self {
            binding: binding.into(),
            contract_digest: contract_digest.into(),
            entry: entry.into(),
            handoff: None,
            interface_digest: interface_digest.into(),
            module: module.into(),
        }
    }

    pub fn with_handoff(mut self, handoff: NativeProjectHandoff) -> Self {
        self.handoff = Some(handoff);
        self
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeProjectHandoff {
    pub max_bytes: usize,
    pub type_name: String,
    pub value_digest: String,
}

impl NativeProjectHandoff {
    pub fn new(
        type_name: impl Into<String>,
        max_bytes: usize,
        value_digest: impl Into<String>,
    ) -> Self {
        Self {
            max_bytes,
            type_name: type_name.into(),
            value_digest: value_digest.into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeProjectExecutionPlan {
    pub entry: String,
    pub module: String,
    pub schema: String,
    pub root_handoff: Option<NativeProjectHandoff>,
    pub steps: Vec<NativeProjectExecutionStep>,
}

impl NativeProjectExecutionPlan {
    pub fn new(
        module: impl Into<String>,
        entry: impl Into<String>,
        steps: Vec<NativeProjectExecutionStep>,
    ) -> Self {
        Self {
            entry: entry.into(),
            module: module.into(),
            schema: PROJECT_EXECUTION_PLAN_SCHEMA.to_owned(),
            root_handoff: None,
            steps,
        }
    }

    pub fn with_root_handoff(mut self, handoff: NativeProjectHandoff) -> Self {
        self.root_handoff = Some(handoff);
        self
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeProjectExecution {
    pub execution_digest: String,
    pub graph_revision: String,
    pub input_digest: String,
    pub plan_digest: String,
    pub profile_digest: String,
    pub project_digest: String,
    pub schema: String,
    pub steps: Vec<NativeProjectRun>,
    pub toolchain_digest: String,
    pub handoffs: Vec<NativeProjectExecutionValueHandoff>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeProjectExecutionValueHandoff {
    pub from_entry: String,
    pub from_module: String,
    pub to_entry: String,
    pub to_module: String,
    pub type_name: String,
    pub value: String,
    pub value_digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeProjectExecutionCacheResult {
    pub artifact_digest: String,
    pub cache_hit: bool,
    pub execution: NativeProjectExecution,
}

pub fn translate_project_module(
    project_directory: impl AsRef<Path>,
    cache_directory: impl AsRef<Path>,
    build_directory: impl AsRef<Path>,
    profile_digest: &str,
    toolchain_digest: &str,
    module_name: &str,
) -> Result<NativeProjectTranslation, ProjectRuntimeError> {
    translate_project_entry(
        project_directory,
        cache_directory,
        build_directory,
        profile_digest,
        toolchain_digest,
        module_name,
        "main",
    )
}

pub fn translate_project_entry(
    project_directory: impl AsRef<Path>,
    cache_directory: impl AsRef<Path>,
    build_directory: impl AsRef<Path>,
    profile_digest: &str,
    toolchain_digest: &str,
    module_name: &str,
    entry_name: &str,
) -> Result<NativeProjectTranslation, ProjectRuntimeError> {
    let (_, _, trusted) = trusted_translation(
        project_directory,
        cache_directory,
        build_directory,
        profile_digest,
        toolchain_digest,
        module_name,
        entry_name,
    )?;
    Ok(trusted.translation)
}

#[allow(clippy::too_many_arguments)]
pub fn execute_project_module(
    project_directory: impl AsRef<Path>,
    cache_directory: impl AsRef<Path>,
    build_directory: impl AsRef<Path>,
    profile_digest: &str,
    toolchain_digest: &str,
    module_name: &str,
    supplied_translation: &NativeProjectTranslation,
    input_digest: &str,
    bridge: &mut dyn CapabilityBridge,
    limits: VmLimits,
) -> Result<NativeProjectRun, ProjectRuntimeError> {
    execute_project_entry(
        project_directory,
        cache_directory,
        build_directory,
        profile_digest,
        toolchain_digest,
        module_name,
        "main",
        supplied_translation,
        input_digest,
        bridge,
        limits.clone(),
    )
}

#[allow(clippy::too_many_arguments)]
pub fn execute_project_entry(
    project_directory: impl AsRef<Path>,
    cache_directory: impl AsRef<Path>,
    build_directory: impl AsRef<Path>,
    profile_digest: &str,
    toolchain_digest: &str,
    module_name: &str,
    entry_name: &str,
    supplied_translation: &NativeProjectTranslation,
    input_digest: &str,
    bridge: &mut dyn CapabilityBridge,
    limits: VmLimits,
) -> Result<NativeProjectRun, ProjectRuntimeError> {
    validate_translation(supplied_translation)?;
    let (project, build, trusted) = trusted_translation(
        project_directory,
        cache_directory,
        build_directory,
        profile_digest,
        toolchain_digest,
        module_name,
        entry_name,
    )?;
    if supplied_translation != &trusted.translation {
        return Err(ProjectRuntimeError::new(
            "native-project-translation-mismatch",
        ));
    }
    execute_trusted_project_entry(&project, &build, &trusted, input_digest, bridge, limits)
}

fn execute_trusted_project_entry(
    project: &NativeProject,
    build: &NativeBuildResult,
    trusted: &TrustedTranslation,
    input_digest: &str,
    bridge: &mut dyn CapabilityBridge,
    limits: VmLimits,
) -> Result<NativeProjectRun, ProjectRuntimeError> {
    execute_trusted_project_entry_with_value(
        project,
        build,
        trusted,
        input_digest,
        bridge,
        limits,
        None,
    )
    .map(|(run, _)| run)
}

fn execute_trusted_project_entry_with_value(
    project: &NativeProject,
    build: &NativeBuildResult,
    trusted: &TrustedTranslation,
    input_digest: &str,
    bridge: &mut dyn CapabilityBridge,
    limits: VmLimits,
    input_value: Option<&VmValue>,
) -> Result<(NativeProjectRun, VmValue), ProjectRuntimeError> {
    let request = VmRequest::new(
        trusted.translation.graph_revision.clone(),
        trusted.artifact.artifact_digest.clone(),
        trusted.artifact.profile.clone(),
        input_digest,
    );
    let vm = match input_value {
        Some(value) => execute_bytecode_with_input_value(
            &trusted.graph,
            &trusted.translation.artifact_source,
            &request,
            bridge,
            limits,
            value,
        ),
        None => execute_bytecode_with_return_value(
            &trusted.graph,
            &trusted.translation.artifact_source,
            &request,
            bridge,
            limits,
        ),
    }
    .map_err(|error| ProjectRuntimeError::new(&error.code))?;
    if vm.result.graph_revision != trusted.translation.graph_revision
        || vm.result.artifact_digest != trusted.translation.artifact_digest
        || vm.result.profile != NATIVE_VM_PROFILE
        || vm.result.input_digest != input_digest
    {
        return Err(ProjectRuntimeError::new(
            "native-project-run-authority-mismatch",
        ));
    }
    Ok((
        make_run(project, build, trusted.translation.clone(), vm.result),
        vm.returned_value,
    ))
}

#[allow(clippy::too_many_arguments)]
pub fn execute_project_execution_plan(
    project_directory: impl AsRef<Path>,
    cache_directory: impl AsRef<Path>,
    build_directory: impl AsRef<Path>,
    profile_digest: &str,
    toolchain_digest: &str,
    plan: &NativeProjectExecutionPlan,
    input_digest: &str,
    bridge: &mut dyn CapabilityBridge,
    limits: VmLimits,
) -> Result<NativeProjectExecution, ProjectRuntimeError> {
    execute_project_execution_plan_direct(
        project_directory,
        cache_directory,
        build_directory,
        profile_digest,
        toolchain_digest,
        plan,
        input_digest,
        bridge,
        limits,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn execute_project_execution_plan_direct(
    project_directory: impl AsRef<Path>,
    cache_directory: impl AsRef<Path>,
    build_directory: impl AsRef<Path>,
    profile_digest: &str,
    toolchain_digest: &str,
    plan: &NativeProjectExecutionPlan,
    input_digest: &str,
    bridge: &mut dyn CapabilityBridge,
    limits: VmLimits,
) -> Result<NativeProjectExecution, ProjectRuntimeError> {
    validate_execution_plan(plan)?;
    validate_digest(input_digest, "native-vm-request-input-digest-invalid")?;
    let (project, build, trusted_bundle) = prepare_trusted_execution_bundle(
        &project_directory,
        &cache_directory,
        &build_directory,
        profile_digest,
        toolchain_digest,
        plan,
    )?;
    execute_trusted_execution_plan(
        &project,
        &build,
        &trusted_bundle,
        profile_digest,
        toolchain_digest,
        plan,
        input_digest,
        bridge,
        limits,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn execute_project_execution_plan_cached(
    project_directory: impl AsRef<Path>,
    cache_directory: impl AsRef<Path>,
    build_directory: impl AsRef<Path>,
    execution_cache_path: impl AsRef<Path>,
    profile_digest: &str,
    toolchain_digest: &str,
    plan: &NativeProjectExecutionPlan,
    input_digest: &str,
    bridge: &mut dyn CapabilityBridge,
    limits: VmLimits,
) -> Result<NativeProjectExecutionCacheResult, ProjectRuntimeError> {
    validate_execution_plan(plan)?;
    validate_digest(input_digest, "native-vm-request-input-digest-invalid")?;

    // Rebuild the current authority once. The disk entry can only prove that the
    // same trusted translations were already materialized.
    let (project, build, trusted_bundle) = prepare_trusted_execution_bundle(
        &project_directory,
        &cache_directory,
        &build_directory,
        profile_digest,
        toolchain_digest,
        plan,
    )?;
    let expected = NativeProjectExecutionArtifact::new(
        &project,
        plan,
        profile_digest,
        toolchain_digest,
        trusted_bundle
            .iter()
            .map(|value| value.translation.clone())
            .collect::<Vec<_>>(),
    )?;
    let cache_hit = match read_execution_artifact(execution_cache_path.as_ref(), &expected)? {
        Some(_) => true,
        None => {
            write_execution_artifact(execution_cache_path.as_ref(), &expected)?;
            false
        }
    };
    let execution = execute_trusted_execution_plan(
        &project,
        &build,
        &trusted_bundle,
        profile_digest,
        toolchain_digest,
        plan,
        input_digest,
        bridge,
        limits,
    )?;
    Ok(NativeProjectExecutionCacheResult {
        artifact_digest: expected.artifact_digest,
        cache_hit,
        execution,
    })
}

#[allow(clippy::too_many_arguments)]
fn execute_trusted_execution_plan(
    project: &NativeProject,
    build: &NativeBuildResult,
    trusted_bundle: &[TrustedTranslation],
    profile_digest: &str,
    toolchain_digest: &str,
    plan: &NativeProjectExecutionPlan,
    input_digest: &str,
    bridge: &mut dyn CapabilityBridge,
    limits: VmLimits,
) -> Result<NativeProjectExecution, ProjectRuntimeError> {
    if trusted_bundle.len() != plan.steps.len() + 1 {
        return Err(ProjectRuntimeError::new(
            "native-project-execution-cache-authority-invalid",
        ));
    }
    let mut executions = Vec::with_capacity(trusted_bundle.len());
    let mut handoffs = Vec::new();
    let mut previous: Option<(String, String, VmValue)> = None;
    for (trusted, step) in trusted_bundle.iter().zip(&plan.steps) {
        if trusted.translation.module != step.module || trusted.translation.entry != step.entry {
            return Err(ProjectRuntimeError::new(
                "native-project-execution-cache-authority-invalid",
            ));
        }
        let input_value = validate_declared_handoff(step.handoff.as_ref(), previous.as_ref())?;
        let (execution, returned_value) = execute_trusted_project_entry_with_value(
            project,
            build,
            trusted,
            input_digest,
            bridge,
            limits.clone(),
            input_value,
        )?;
        if let (Some(declared), Some((from_module, from_entry, value))) =
            (step.handoff.as_ref(), previous.as_ref())
        {
            handoffs.push(make_handoff(
                from_module,
                from_entry,
                &step.module,
                &step.entry,
                declared,
                value,
            )?);
        }
        executions.push(execution);
        previous = Some((step.module.clone(), step.entry.clone(), returned_value));
    }
    let root = trusted_bundle.last().ok_or_else(|| {
        ProjectRuntimeError::new("native-project-execution-cache-authority-invalid")
    })?;
    if root.translation.module != plan.module || root.translation.entry != plan.entry {
        return Err(ProjectRuntimeError::new(
            "native-project-execution-cache-authority-invalid",
        ));
    }
    let root_input = validate_declared_handoff(plan.root_handoff.as_ref(), previous.as_ref())?;
    let (root_execution, _) = execute_trusted_project_entry_with_value(
        project,
        build,
        root,
        input_digest,
        bridge,
        limits,
        root_input,
    )?;
    if let (Some(declared), Some((from_module, from_entry, value))) =
        (plan.root_handoff.as_ref(), previous.as_ref())
    {
        handoffs.push(make_handoff(
            from_module,
            from_entry,
            &plan.module,
            &plan.entry,
            declared,
            value,
        )?);
    }
    executions.push(root_execution);
    make_execution(
        project,
        plan,
        profile_digest,
        toolchain_digest,
        input_digest,
        executions,
        handoffs,
    )
}

const MAX_HANDOFF_BYTES: usize = 64 * 1024;

fn validate_declared_handoff<'a>(
    declared: Option<&'a NativeProjectHandoff>,
    previous: Option<&'a (String, String, VmValue)>,
) -> Result<Option<&'a VmValue>, ProjectRuntimeError> {
    let Some(declared) = declared else {
        return Ok(None);
    };
    if declared.max_bytes == 0 || declared.max_bytes > MAX_HANDOFF_BYTES {
        return Err(ProjectRuntimeError::new(
            "native-project-value-handoff-bound-invalid",
        ));
    }
    validate_digest(
        &declared.value_digest,
        "native-project-value-handoff-digest-invalid",
    )?;
    let Some((_, _, value)) = previous else {
        return Err(ProjectRuntimeError::new(
            "native-project-value-handoff-source-missing",
        ));
    };
    let serialized = serialize_vm_value(value);
    if serialized.len() > declared.max_bytes {
        return Err(ProjectRuntimeError::new(
            "native-project-value-handoff-too-large",
        ));
    }
    if vm_value_type_name(value) != declared.type_name {
        return Err(ProjectRuntimeError::new(
            "native-project-value-handoff-type-mismatch",
        ));
    }
    if vm_value_digest(value) != declared.value_digest {
        return Err(ProjectRuntimeError::new(
            "native-project-value-handoff-digest-mismatch",
        ));
    }
    Ok(Some(value))
}

fn make_handoff(
    from_module: &str,
    from_entry: &str,
    to_module: &str,
    to_entry: &str,
    declared: &NativeProjectHandoff,
    value: &VmValue,
) -> Result<NativeProjectExecutionValueHandoff, ProjectRuntimeError> {
    let value = serialize_vm_value(value);
    let value_digest = vm_value_digest_from_serialized(&value);
    if value_digest != declared.value_digest {
        return Err(ProjectRuntimeError::new(
            "native-project-value-handoff-digest-mismatch",
        ));
    }
    Ok(NativeProjectExecutionValueHandoff {
        from_entry: from_entry.to_owned(),
        from_module: from_module.to_owned(),
        to_entry: to_entry.to_owned(),
        to_module: to_module.to_owned(),
        type_name: declared.type_name.clone(),
        value,
        value_digest,
    })
}

fn vm_value_digest_from_serialized(value: &str) -> String {
    format!("sha256:{}", sha256_hex(value.as_bytes()))
}

fn make_execution(
    project: &NativeProject,
    plan: &NativeProjectExecutionPlan,
    profile_digest: &str,
    toolchain_digest: &str,
    input_digest: &str,
    executions: Vec<NativeProjectRun>,
    handoffs: Vec<NativeProjectExecutionValueHandoff>,
) -> Result<NativeProjectExecution, ProjectRuntimeError> {
    let mut execution = NativeProjectExecution {
        execution_digest: String::new(),
        graph_revision: project.graph_revision.clone(),
        input_digest: input_digest.to_owned(),
        plan_digest: execution_plan_digest(plan),
        profile_digest: profile_digest.to_owned(),
        project_digest: project.project_digest.clone(),
        schema: PROJECT_EXECUTION_SCHEMA.to_owned(),
        steps: executions,
        toolchain_digest: toolchain_digest.to_owned(),
        handoffs,
    };
    execution.execution_digest = execution_digest(&execution)?;
    Ok(execution)
}

pub fn project_translation_digest(translation: &NativeProjectTranslation) -> String {
    translation_digest(translation)
}

pub fn serialize_project_translation(
    translation: &NativeProjectTranslation,
) -> Result<String, ProjectRuntimeError> {
    validate_translation(translation)?;
    Ok(format!(
        "{}\n",
        canonicalize(&translation_json(translation))
    ))
}

pub fn serialize_project_run(run: &NativeProjectRun) -> Result<String, ProjectRuntimeError> {
    validate_translation(&run.translation)?;
    if run.schema != PROJECT_RUN_SCHEMA
        || run.module != run.translation.module
        || run.project_digest != run.translation.project_digest
        || run.graph_revision != run.translation.graph_revision
        || run.build_key != run.translation.build_key
        || run.vm.graph_revision != run.graph_revision
        || run.vm.artifact_digest != run.translation.artifact_digest
        || run.vm.input_digest != run.input_digest
        || run.run_digest != run_digest(run)
    {
        return Err(ProjectRuntimeError::new(
            "native-project-run-authority-mismatch",
        ));
    }
    Ok(format!("{}\n", canonicalize(&run_json(run))))
}

pub fn serialize_project_execution_plan(
    plan: &NativeProjectExecutionPlan,
) -> Result<String, ProjectRuntimeError> {
    validate_execution_plan(plan)?;
    let value = plan_json(plan, true);
    Ok(format!("{}\n", canonicalize(&value)))
}

pub fn parse_project_execution_plan(
    source: &str,
) -> Result<NativeProjectExecutionPlan, ProjectRuntimeError> {
    let value = parse_json(source).map_err(|error| ProjectRuntimeError::new(&error.code))?;
    let plan = parse_plan_value(&value)?;
    let canonical = serialize_project_execution_plan(&plan)?;
    if canonical != source {
        return Err(ProjectRuntimeError::new(
            "native-project-execution-plan-non-canonical-source",
        ));
    }
    Ok(plan)
}

fn parse_plan_value(value: &JsonValue) -> Result<NativeProjectExecutionPlan, ProjectRuntimeError> {
    let entries = exact_object(
        value,
        &[
            "entry",
            "module",
            "plan_digest",
            "root_handoff",
            "schema",
            "steps",
        ],
    )
    .map_err(|error| ProjectRuntimeError::new(&error.code))?;
    let plan = NativeProjectExecutionPlan {
        entry: required_string(&entries, "entry")?,
        module: required_string(&entries, "module")?,
        root_handoff: entries
            .get("root_handoff")
            .map(|value| parse_handoff(value))
            .transpose()?,
        schema: required_string(&entries, "schema")?,
        steps: parse_plan_steps(entries.get("steps").copied())?,
    };
    validate_execution_plan(&plan)?;
    if required_string(&entries, "plan_digest")? != execution_plan_digest(&plan) {
        return Err(ProjectRuntimeError::new(
            "native-project-execution-plan-digest-mismatch",
        ));
    }
    Ok(plan)
}

pub fn serialize_project_execution(
    execution: &NativeProjectExecution,
) -> Result<String, ProjectRuntimeError> {
    let _ = execution_json_without_digest(execution)?;
    if execution.handoffs.iter().any(|handoff| {
        handoff.from_module.is_empty()
            || handoff.from_entry.is_empty()
            || handoff.to_module.is_empty()
            || handoff.to_entry.is_empty()
            || handoff.type_name.is_empty()
            || handoff.value.is_empty()
            || validate_handoff_output(handoff).is_err()
    }) {
        return Err(ProjectRuntimeError::new(
            "native-project-value-handoff-value-mismatch",
        ));
    }
    if execution.schema != PROJECT_EXECUTION_SCHEMA
        || execution.execution_digest != execution_digest(execution)?
        || execution.steps.is_empty()
        || execution.steps.iter().any(|step| {
            step.project_digest != execution.project_digest
                || step.input_digest != execution.input_digest
        })
    {
        return Err(ProjectRuntimeError::new(
            "native-project-execution-authority-mismatch",
        ));
    }
    Ok(format!("{}\n", canonicalize(&execution_json(execution)?)))
}

struct TrustedTranslation {
    artifact: BytecodeArtifact,
    graph: Graph,
    translation: NativeProjectTranslation,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct NativeProjectExecutionArtifact {
    artifact_digest: String,
    graph_revision: String,
    plan: NativeProjectExecutionPlan,
    plan_digest: String,
    profile_digest: String,
    project_digest: String,
    schema: String,
    toolchain_digest: String,
    translations: Vec<NativeProjectTranslation>,
}

impl NativeProjectExecutionArtifact {
    fn new(
        project: &NativeProject,
        plan: &NativeProjectExecutionPlan,
        profile_digest: &str,
        toolchain_digest: &str,
        translations: Vec<NativeProjectTranslation>,
    ) -> Result<Self, ProjectRuntimeError> {
        validate_digest(
            profile_digest,
            "native-project-execution-cache-authority-invalid",
        )?;
        validate_digest(
            toolchain_digest,
            "native-project-execution-cache-authority-invalid",
        )?;
        if translations.is_empty()
            || translations
                .iter()
                .any(|translation| validate_translation(translation).is_err())
        {
            return Err(ProjectRuntimeError::new(
                "native-project-execution-cache-authority-invalid",
            ));
        }
        let mut artifact = Self {
            artifact_digest: String::new(),
            graph_revision: project.graph_revision.clone(),
            plan: plan.clone(),
            plan_digest: execution_plan_digest(plan),
            profile_digest: profile_digest.to_owned(),
            project_digest: project.project_digest.clone(),
            schema: PROJECT_EXECUTION_ARTIFACT_CACHE_SCHEMA.to_owned(),
            toolchain_digest: toolchain_digest.to_owned(),
            translations,
        };
        artifact.artifact_digest = execution_artifact_digest(&artifact);
        Ok(artifact)
    }
}

fn read_execution_artifact(
    path: &Path,
    expected: &NativeProjectExecutionArtifact,
) -> Result<Option<NativeProjectExecutionArtifact>, ProjectRuntimeError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err(ProjectRuntimeError::new(
                "native-project-execution-cache-read-failure",
            ));
        }
    };
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
        return Err(ProjectRuntimeError::new(
            "native-project-execution-cache-corrupt",
        ));
    }
    let source = fs::read_to_string(path)
        .map_err(|_| ProjectRuntimeError::new("native-project-execution-cache-read-failure"))?;
    let value = parse_json(&source)
        .map_err(|_| ProjectRuntimeError::new("native-project-execution-cache-corrupt"))?;
    let artifact = parse_execution_artifact(&value)?;
    let canonical = serialize_execution_artifact(&artifact)?;
    if canonical != source || artifact.artifact_digest != execution_artifact_digest(&artifact) {
        return Err(ProjectRuntimeError::new(
            "native-project-execution-cache-corrupt",
        ));
    }
    if artifact.graph_revision != expected.graph_revision
        || artifact.plan_digest != expected.plan_digest
        || artifact.profile_digest != expected.profile_digest
        || artifact.project_digest != expected.project_digest
        || artifact.toolchain_digest != expected.toolchain_digest
    {
        return Ok(None);
    }
    if artifact.plan != expected.plan {
        return Err(ProjectRuntimeError::new(
            "native-project-execution-cache-semantic-mismatch",
        ));
    }
    if artifact.translations != expected.translations {
        return Err(ProjectRuntimeError::new(
            "native-project-execution-cache-semantic-mismatch",
        ));
    }
    Ok(Some(artifact))
}

fn write_execution_artifact(
    path: &Path,
    artifact: &NativeProjectExecutionArtifact,
) -> Result<(), ProjectRuntimeError> {
    let parent = path
        .parent()
        .ok_or_else(|| ProjectRuntimeError::new("native-project-execution-cache-write-failure"))?;
    if fs::symlink_metadata(parent)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(ProjectRuntimeError::new(
            "native-project-execution-cache-write-failure",
        ));
    }
    fs::create_dir_all(parent)
        .map_err(|_| ProjectRuntimeError::new("native-project-execution-cache-write-failure"))?;
    let temporary = parent.join(format!(
        ".revia-execution-{}-{}",
        std::process::id(),
        EXECUTION_CACHE_NONCE.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&temporary)
        .map_err(|_| ProjectRuntimeError::new("native-project-execution-cache-write-failure"))?;
    let temporary_file = temporary.join("artifact.json");
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_file)
            .map_err(|_| {
                ProjectRuntimeError::new("native-project-execution-cache-write-failure")
            })?;
        file.write_all(serialize_execution_artifact(artifact)?.as_bytes())
            .map_err(|_| {
                ProjectRuntimeError::new("native-project-execution-cache-write-failure")
            })?;
        fs::rename(&temporary_file, path).map_err(|_| {
            ProjectRuntimeError::new("native-project-execution-cache-write-failure")
        })?;
        Ok(())
    })();
    if temporary.exists() {
        let _ = fs::remove_dir_all(&temporary);
    }
    result
}

fn parse_execution_artifact(
    value: &JsonValue,
) -> Result<NativeProjectExecutionArtifact, ProjectRuntimeError> {
    let entries = exact_object(
        value,
        &[
            "artifact_digest",
            "graph_revision",
            "plan",
            "plan_digest",
            "profile_digest",
            "project_digest",
            "schema",
            "toolchain_digest",
            "translations",
        ],
    )
    .map_err(|error| ProjectRuntimeError::new(&error.code))?;
    let JsonValue::Array(values) = entries
        .get("translations")
        .copied()
        .ok_or_else(|| ProjectRuntimeError::new("native-project-execution-cache-corrupt"))?
    else {
        return Err(ProjectRuntimeError::new(
            "native-project-execution-cache-corrupt",
        ));
    };
    let translations = values
        .iter()
        .map(parse_translation)
        .collect::<Result<Vec<_>, _>>()?;
    if translations.is_empty() {
        return Err(ProjectRuntimeError::new(
            "native-project-execution-cache-corrupt",
        ));
    }
    let artifact =
        NativeProjectExecutionArtifact {
            artifact_digest: required_string(&entries, "artifact_digest")?,
            graph_revision: required_string(&entries, "graph_revision")?,
            plan: parse_plan_value(entries.get("plan").copied().ok_or_else(|| {
                ProjectRuntimeError::new("native-project-execution-cache-corrupt")
            })?)?,
            plan_digest: required_string(&entries, "plan_digest")?,
            profile_digest: required_string(&entries, "profile_digest")?,
            project_digest: required_string(&entries, "project_digest")?,
            schema: required_string(&entries, "schema")?,
            toolchain_digest: required_string(&entries, "toolchain_digest")?,
            translations,
        };
    if artifact.schema != PROJECT_EXECUTION_ARTIFACT_CACHE_SCHEMA
        || artifact.plan_digest != execution_plan_digest(&artifact.plan)
    {
        return Err(ProjectRuntimeError::new(
            "native-project-execution-cache-corrupt",
        ));
    }
    Ok(artifact)
}

fn parse_translation(value: &JsonValue) -> Result<NativeProjectTranslation, ProjectRuntimeError> {
    let entries = exact_object(
        value,
        &[
            "artifact_digest",
            "artifact_source",
            "build_key",
            "build_manifest_digest",
            "graph_revision",
            "module_artifact_digest",
            "module_cache_key",
            "module",
            "entry",
            "profile",
            "profile_digest",
            "project_graph_revision",
            "project_digest",
            "schema",
            "toolchain_digest",
            "translation_digest",
        ],
    )
    .map_err(|error| ProjectRuntimeError::new(&error.code))?;
    let translation = NativeProjectTranslation {
        artifact_digest: required_string(&entries, "artifact_digest")?,
        artifact_source: required_string(&entries, "artifact_source")?,
        build_key: required_string(&entries, "build_key")?,
        build_manifest_digest: required_string(&entries, "build_manifest_digest")?,
        graph_revision: required_string(&entries, "graph_revision")?,
        module_artifact_digest: required_string(&entries, "module_artifact_digest")?,
        module_cache_key: required_string(&entries, "module_cache_key")?,
        module: required_string(&entries, "module")?,
        entry: required_string(&entries, "entry")?,
        profile: required_string(&entries, "profile")?,
        profile_digest: required_string(&entries, "profile_digest")?,
        project_graph_revision: required_string(&entries, "project_graph_revision")?,
        project_digest: required_string(&entries, "project_digest")?,
        schema: required_string(&entries, "schema")?,
        toolchain_digest: required_string(&entries, "toolchain_digest")?,
        translation_digest: required_string(&entries, "translation_digest")?,
    };
    validate_translation(&translation)?;
    Ok(translation)
}

fn serialize_execution_artifact(
    artifact: &NativeProjectExecutionArtifact,
) -> Result<String, ProjectRuntimeError> {
    Ok(format!(
        "{}\n",
        canonicalize(&execution_artifact_json(artifact))
    ))
}

fn execution_artifact_json(artifact: &NativeProjectExecutionArtifact) -> JsonValue {
    object(vec![
        (
            "artifact_digest",
            JsonValue::String(artifact.artifact_digest.clone()),
        ),
        (
            "graph_revision",
            JsonValue::String(artifact.graph_revision.clone()),
        ),
        ("plan", plan_json(&artifact.plan, true)),
        (
            "plan_digest",
            JsonValue::String(artifact.plan_digest.clone()),
        ),
        (
            "profile_digest",
            JsonValue::String(artifact.profile_digest.clone()),
        ),
        (
            "project_digest",
            JsonValue::String(artifact.project_digest.clone()),
        ),
        ("schema", JsonValue::String(artifact.schema.clone())),
        (
            "toolchain_digest",
            JsonValue::String(artifact.toolchain_digest.clone()),
        ),
        (
            "translations",
            JsonValue::Array(artifact.translations.iter().map(translation_json).collect()),
        ),
    ])
}

fn execution_artifact_content(artifact: &NativeProjectExecutionArtifact) -> JsonValue {
    let mut fields = match execution_artifact_json(artifact) {
        JsonValue::Object(fields) => fields,
        _ => unreachable!(),
    };
    fields.retain(|(name, _)| name != "artifact_digest");
    JsonValue::Object(fields)
}

fn execution_artifact_digest(artifact: &NativeProjectExecutionArtifact) -> String {
    format!(
        "sha256:{}",
        sha256_hex(canonicalize(&execution_artifact_content(artifact)).as_bytes())
    )
}

fn trusted_translation(
    project_directory: impl AsRef<Path>,
    cache_directory: impl AsRef<Path>,
    build_directory: impl AsRef<Path>,
    profile_digest: &str,
    toolchain_digest: &str,
    module_name: &str,
    entry_name: &str,
) -> Result<(NativeProject, NativeBuildResult, TrustedTranslation), ProjectRuntimeError> {
    let project = load_project_directory(&project_directory)
        .map_err(|error| ProjectRuntimeError::new(&error.code))?;
    let build = build_project(
        &project_directory,
        &cache_directory,
        &build_directory,
        profile_digest,
        toolchain_digest,
        None,
    )
    .map_err(|error| ProjectRuntimeError::new(&error.code))?;
    let trusted = trusted_translation_from_authority(
        &project,
        &build,
        project_directory.as_ref(),
        profile_digest,
        toolchain_digest,
        module_name,
        entry_name,
    )?;
    Ok((project, build, trusted))
}

fn prepare_trusted_execution_bundle(
    project_directory: impl AsRef<Path>,
    cache_directory: impl AsRef<Path>,
    build_directory: impl AsRef<Path>,
    profile_digest: &str,
    toolchain_digest: &str,
    plan: &NativeProjectExecutionPlan,
) -> Result<(NativeProject, NativeBuildResult, Vec<TrustedTranslation>), ProjectRuntimeError> {
    let project = load_project_directory(&project_directory)
        .map_err(|error| ProjectRuntimeError::new(&error.code))?;
    validate_plan_chain(&project, plan)?;
    let build = build_project(
        &project_directory,
        &cache_directory,
        &build_directory,
        profile_digest,
        toolchain_digest,
        None,
    )
    .map_err(|error| ProjectRuntimeError::new(&error.code))?;
    let mut trusted = Vec::with_capacity(plan.steps.len() + 1);
    for step in &plan.steps {
        trusted.push(trusted_translation_from_authority(
            &project,
            &build,
            project_directory.as_ref(),
            profile_digest,
            toolchain_digest,
            &step.module,
            &step.entry,
        )?);
    }
    trusted.push(trusted_translation_from_authority(
        &project,
        &build,
        project_directory.as_ref(),
        profile_digest,
        toolchain_digest,
        &plan.module,
        &plan.entry,
    )?);
    Ok((project, build, trusted))
}

fn trusted_translation_from_authority(
    project: &NativeProject,
    build: &NativeBuildResult,
    project_directory: &Path,
    profile_digest: &str,
    toolchain_digest: &str,
    module_name: &str,
    entry_name: &str,
) -> Result<TrustedTranslation, ProjectRuntimeError> {
    let module = project
        .modules
        .iter()
        .find(|module| module.name == module_name)
        .ok_or_else(|| ProjectRuntimeError::new("native-project-entry-not-found"))?;
    let build_module = build
        .manifest
        .modules
        .iter()
        .find(|candidate| candidate.module == module.name)
        .ok_or_else(|| ProjectRuntimeError::new("native-project-entry-not-found"))?;
    let source_path = project_directory.join(&module.path);
    let bytes = fs::read(&source_path)
        .map_err(|_| ProjectRuntimeError::new("native-project-source-unreadable"))?;
    let source = SourceText::from_bytes(&bytes, &module.path)
        .map_err(|error| ProjectRuntimeError::new(&error.code))?;
    let graph = if source.text.starts_with("re 0.1 canonical\n") {
        load_canonical_graph(&source.text)
    } else {
        parse_compact_graph(&source.text, &module.path).and_then(check_graph)
    }
    .map_err(|error| ProjectRuntimeError::new(&error.code))?;
    let artifact =
        translate_graph(&graph).map_err(|error| ProjectRuntimeError::new(&error.code))?;
    let graph_entry_name = graph
        .functions
        .first()
        .and_then(|function| function.name.strip_prefix('@'))
        .ok_or_else(|| ProjectRuntimeError::new("native-project-entry-symbol-mismatch"))?;
    if graph_entry_name != entry_name {
        return Err(ProjectRuntimeError::new(
            "native-project-entry-symbol-mismatch",
        ));
    }
    if !project
        .package_manifest
        .modules
        .iter()
        .find(|candidate| candidate.name == module.name)
        .is_some_and(|candidate| {
            candidate
                .interface
                .exports
                .iter()
                .any(|export| export.kind == "function" && export.name == entry_name)
        })
    {
        return Err(ProjectRuntimeError::new(
            "native-project-entry-symbol-mismatch",
        ));
    }
    let artifact_source = serialize_bytecode_artifact(&artifact)
        .map_err(|error| ProjectRuntimeError::new(&error.code))?;
    let mut translation = NativeProjectTranslation {
        artifact_digest: artifact.artifact_digest.clone(),
        artifact_source,
        build_key: build.manifest.build_key.clone(),
        build_manifest_digest: build.manifest.manifest_digest.clone(),
        graph_revision: artifact.graph_revision.clone(),
        module_artifact_digest: build_module.artifact_digest.clone(),
        module_cache_key: build_module.cache_key.clone(),
        module: module.name.clone(),
        entry: entry_name.to_owned(),
        profile: artifact.profile.clone(),
        profile_digest: profile_digest.to_owned(),
        project_graph_revision: project.graph_revision.clone(),
        project_digest: project.project_digest.clone(),
        schema: PROJECT_TRANSLATION_SCHEMA.to_owned(),
        toolchain_digest: toolchain_digest.to_owned(),
        translation_digest: String::new(),
    };
    translation.translation_digest = translation_digest(&translation);
    Ok(TrustedTranslation {
        artifact,
        graph,
        translation,
    })
}

fn make_run(
    project: &NativeProject,
    build: &NativeBuildResult,
    translation: NativeProjectTranslation,
    vm: VmResult,
) -> NativeProjectRun {
    let mut run = NativeProjectRun {
        build_key: build.manifest.build_key.clone(),
        graph_revision: translation.graph_revision.clone(),
        input_digest: vm.input_digest.clone(),
        module: translation.module.clone(),
        project_digest: project.project_digest.clone(),
        run_digest: String::new(),
        schema: PROJECT_RUN_SCHEMA.to_owned(),
        translation,
        vm,
    };
    run.run_digest = run_digest(&run);
    run
}

fn validate_translation(translation: &NativeProjectTranslation) -> Result<(), ProjectRuntimeError> {
    if translation.schema != PROJECT_TRANSLATION_SCHEMA
        || translation.artifact_source.is_empty()
        || translation.module_artifact_digest.is_empty()
        || translation.module_cache_key.is_empty()
        || translation.entry.is_empty()
        || translation.profile_digest.is_empty()
        || translation.translation_digest != translation_digest(translation)
    {
        return Err(ProjectRuntimeError::new(
            "native-project-translation-digest-mismatch",
        ));
    }
    Ok(())
}

fn translation_digest(translation: &NativeProjectTranslation) -> String {
    format!(
        "sha256:{}",
        sha256_hex(canonicalize(&translation_json_without_digest(translation)).as_bytes())
    )
}

fn run_digest(run: &NativeProjectRun) -> String {
    format!(
        "sha256:{}",
        sha256_hex(canonicalize(&run_json_without_digest(run)).as_bytes())
    )
}

fn translation_json(translation: &NativeProjectTranslation) -> JsonValue {
    let mut fields = translation_fields(translation);
    fields.push((
        "translation_digest",
        JsonValue::String(translation.translation_digest.clone()),
    ));
    object(fields)
}

fn translation_json_without_digest(translation: &NativeProjectTranslation) -> JsonValue {
    object(translation_fields(translation))
}

fn translation_fields(translation: &NativeProjectTranslation) -> Vec<(&'static str, JsonValue)> {
    vec![
        (
            "artifact_digest",
            JsonValue::String(translation.artifact_digest.clone()),
        ),
        (
            "artifact_source",
            JsonValue::String(translation.artifact_source.clone()),
        ),
        (
            "build_key",
            JsonValue::String(translation.build_key.clone()),
        ),
        (
            "build_manifest_digest",
            JsonValue::String(translation.build_manifest_digest.clone()),
        ),
        (
            "graph_revision",
            JsonValue::String(translation.graph_revision.clone()),
        ),
        (
            "module_artifact_digest",
            JsonValue::String(translation.module_artifact_digest.clone()),
        ),
        (
            "module_cache_key",
            JsonValue::String(translation.module_cache_key.clone()),
        ),
        ("module", JsonValue::String(translation.module.clone())),
        ("entry", JsonValue::String(translation.entry.clone())),
        ("profile", JsonValue::String(translation.profile.clone())),
        (
            "profile_digest",
            JsonValue::String(translation.profile_digest.clone()),
        ),
        (
            "project_graph_revision",
            JsonValue::String(translation.project_graph_revision.clone()),
        ),
        (
            "project_digest",
            JsonValue::String(translation.project_digest.clone()),
        ),
        ("schema", JsonValue::String(translation.schema.clone())),
        (
            "toolchain_digest",
            JsonValue::String(translation.toolchain_digest.clone()),
        ),
    ]
}

fn validate_execution_plan(plan: &NativeProjectExecutionPlan) -> Result<(), ProjectRuntimeError> {
    if plan.schema != PROJECT_EXECUTION_PLAN_SCHEMA
        || !valid_name(&plan.module)
        || !valid_binding(&plan.entry)
        || plan.steps.iter().any(|step| {
            !valid_binding(&step.binding)
                || !valid_name(&step.module)
                || !valid_binding(&step.entry)
                || !valid_digest(&step.interface_digest)
                || !valid_digest(&step.contract_digest)
        })
    {
        return Err(ProjectRuntimeError::new(
            "native-project-execution-plan-invalid",
        ));
    }
    if plan
        .steps
        .first()
        .is_some_and(|step| step.handoff.is_some())
        || (plan.steps.is_empty() && plan.root_handoff.is_some())
    {
        return Err(ProjectRuntimeError::new(
            "native-project-value-handoff-source-missing",
        ));
    }
    for handoff in plan
        .steps
        .iter()
        .filter_map(|step| step.handoff.as_ref())
        .chain(plan.root_handoff.as_ref())
    {
        validate_handoff_declaration(handoff)?;
    }
    let mut bindings = BTreeSet::new();
    if plan
        .steps
        .iter()
        .any(|step| !bindings.insert(step.binding.as_str()))
    {
        return Err(ProjectRuntimeError::new(
            "native-project-execution-plan-duplicate-binding",
        ));
    }
    Ok(())
}

fn validate_plan_chain(
    project: &NativeProject,
    plan: &NativeProjectExecutionPlan,
) -> Result<(), ProjectRuntimeError> {
    let mut current = project_module(project, &plan.module)?;
    validate_export(project, current, &plan.entry, None)?;
    let mut visited = BTreeSet::from([current.name.clone()]);
    for step in &plan.steps {
        let dependency = current
            .dependencies
            .iter()
            .find(|candidate| candidate.binding == step.binding)
            .ok_or_else(|| ProjectRuntimeError::new("native-project-call-binding-not-found"))?;
        if dependency.scope != "package" || dependency.module != step.module {
            return Err(ProjectRuntimeError::new(
                "native-project-call-binding-module-mismatch",
            ));
        }
        if dependency.interface_digest != step.interface_digest {
            return Err(ProjectRuntimeError::new(
                "native-project-call-interface-mismatch",
            ));
        }
        let target = project_module(project, &step.module)?;
        if target.interface_digest != step.interface_digest {
            return Err(ProjectRuntimeError::new(
                "native-project-call-interface-mismatch",
            ));
        }
        if !visited.insert(target.name.clone()) {
            return Err(ProjectRuntimeError::new("native-project-call-cycle"));
        }
        validate_export(project, target, &step.entry, Some(&step.contract_digest))?;
        current = target;
    }
    Ok(())
}

fn validate_export(
    project: &NativeProject,
    module: &NativeProjectModuleLoaded,
    entry: &str,
    expected_contract: Option<&String>,
) -> Result<(), ProjectRuntimeError> {
    let package_export = module_export(project, &module.name, entry);
    let Some(export) = package_export else {
        return Err(ProjectRuntimeError::new(if expected_contract.is_some() {
            "native-project-call-entry-not-exported"
        } else {
            "native-project-entry-not-exported"
        }));
    };
    if let Some(expected) = expected_contract
        && export.contract_digest != *expected
    {
        return Err(ProjectRuntimeError::new(
            "native-project-call-contract-mismatch",
        ));
    }
    Ok(())
}

fn module_export<'a>(
    project: &'a NativeProject,
    module_name: &str,
    entry: &str,
) -> Option<&'a NativeExport> {
    project
        .package_manifest
        .modules
        .iter()
        .find(|module| module.name == module_name)
        .and_then(|module| {
            module
                .interface
                .exports
                .iter()
                .find(|export| export.kind == "function" && export.name == entry)
        })
}

fn project_module<'a>(
    project: &'a NativeProject,
    name: &str,
) -> Result<&'a NativeProjectModuleLoaded, ProjectRuntimeError> {
    project
        .modules
        .iter()
        .find(|module| module.name == name)
        .ok_or_else(|| ProjectRuntimeError::new("native-project-entry-not-found"))
}

fn valid_name(value: &str) -> bool {
    !value.is_empty()
        && value.split('.').all(|part| {
            !part.is_empty()
                && part.as_bytes()[0].is_ascii_lowercase()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
        })
}

fn valid_binding(value: &str) -> bool {
    !value.is_empty()
        && value.as_bytes()[0].is_ascii_lowercase()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

fn valid_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn validate_digest(value: &str, code: &str) -> Result<(), ProjectRuntimeError> {
    if valid_digest(value) {
        Ok(())
    } else {
        Err(ProjectRuntimeError::new(code))
    }
}

fn parse_plan_steps(
    value: Option<&JsonValue>,
) -> Result<Vec<NativeProjectExecutionStep>, ProjectRuntimeError> {
    let Some(JsonValue::Array(values)) = value else {
        return Err(ProjectRuntimeError::new(
            "native-project-execution-plan-steps-invalid",
        ));
    };
    values
        .iter()
        .map(|value| {
            let entries = exact_object(
                value,
                &[
                    "binding",
                    "contract_digest",
                    "entry",
                    "handoff",
                    "interface_digest",
                    "module",
                ],
            )
            .map_err(|error| ProjectRuntimeError::new(&error.code))?;
            let mut step = NativeProjectExecutionStep::new(
                required_string(&entries, "binding")?,
                required_string(&entries, "module")?,
                required_string(&entries, "entry")?,
                required_string(&entries, "interface_digest")?,
                required_string(&entries, "contract_digest")?,
            );
            if let Some(value) = entries.get("handoff") {
                step.handoff = Some(parse_handoff(value)?);
            }
            Ok(step)
        })
        .collect()
}

fn required_string(
    entries: &std::collections::BTreeMap<String, &JsonValue>,
    name: &str,
) -> Result<String, ProjectRuntimeError> {
    string(entries, name)
        .map(str::to_owned)
        .map_err(|error| ProjectRuntimeError::new(&error.code))
}

fn execution_plan_digest(plan: &NativeProjectExecutionPlan) -> String {
    format!(
        "sha256:{}",
        sha256_hex(canonicalize(&plan_json(plan, false)).as_bytes())
    )
}

pub(crate) fn project_execution_plan_digest(plan: &NativeProjectExecutionPlan) -> String {
    execution_plan_digest(plan)
}

fn plan_json(plan: &NativeProjectExecutionPlan, include_digest: bool) -> JsonValue {
    let steps = plan
        .steps
        .iter()
        .map(|step| {
            let mut fields = vec![
                ("binding", JsonValue::String(step.binding.clone())),
                (
                    "contract_digest",
                    JsonValue::String(step.contract_digest.clone()),
                ),
                ("entry", JsonValue::String(step.entry.clone())),
                (
                    "interface_digest",
                    JsonValue::String(step.interface_digest.clone()),
                ),
                ("module", JsonValue::String(step.module.clone())),
            ];
            if let Some(handoff) = &step.handoff {
                fields.push(("handoff", handoff_json(handoff)));
            }
            object(fields)
        })
        .collect();
    let mut fields = vec![
        ("entry", JsonValue::String(plan.entry.clone())),
        ("module", JsonValue::String(plan.module.clone())),
        ("schema", JsonValue::String(plan.schema.clone())),
        ("steps", JsonValue::Array(steps)),
    ];
    if let Some(handoff) = &plan.root_handoff {
        fields.push(("root_handoff", handoff_json(handoff)));
    }
    if include_digest {
        fields.push((
            "plan_digest",
            JsonValue::String(execution_plan_digest(plan)),
        ));
    }
    object(fields)
}

fn validate_handoff_declaration(handoff: &NativeProjectHandoff) -> Result<(), ProjectRuntimeError> {
    if handoff.max_bytes == 0 || handoff.max_bytes > MAX_HANDOFF_BYTES {
        return Err(ProjectRuntimeError::new(
            "native-project-value-handoff-bound-invalid",
        ));
    }
    if handoff.type_name.is_empty()
        || handoff.type_name.len() > 128
        || !handoff
            .type_name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'_')
    {
        return Err(ProjectRuntimeError::new(
            "native-project-value-handoff-type-invalid",
        ));
    }
    validate_digest(
        &handoff.value_digest,
        "native-project-value-handoff-digest-invalid",
    )
}

fn parse_handoff(value: &JsonValue) -> Result<NativeProjectHandoff, ProjectRuntimeError> {
    let entries = exact_object(value, &["max_bytes", "type_name", "value_digest"])
        .map_err(|error| ProjectRuntimeError::new(&error.code))?;
    let JsonValue::Number(max_bytes) = entries
        .get("max_bytes")
        .copied()
        .ok_or_else(|| ProjectRuntimeError::new("native-project-value-handoff-invalid"))?
    else {
        return Err(ProjectRuntimeError::new(
            "native-project-value-handoff-invalid",
        ));
    };
    let max_bytes = max_bytes
        .parse::<usize>()
        .map_err(|_| ProjectRuntimeError::new("native-project-value-handoff-invalid"))?;
    let handoff = NativeProjectHandoff::new(
        required_string(&entries, "type_name")?,
        max_bytes,
        required_string(&entries, "value_digest")?,
    );
    validate_handoff_declaration(&handoff)?;
    Ok(handoff)
}

fn handoff_json(handoff: &NativeProjectHandoff) -> JsonValue {
    object(vec![
        (
            "max_bytes",
            JsonValue::Number(handoff.max_bytes.to_string()),
        ),
        ("type_name", JsonValue::String(handoff.type_name.clone())),
        (
            "value_digest",
            JsonValue::String(handoff.value_digest.clone()),
        ),
    ])
}

fn execution_digest(execution: &NativeProjectExecution) -> Result<String, ProjectRuntimeError> {
    Ok(format!(
        "sha256:{}",
        sha256_hex(canonicalize(&execution_json_without_digest(execution)?).as_bytes())
    ))
}

fn execution_json(execution: &NativeProjectExecution) -> Result<JsonValue, ProjectRuntimeError> {
    let mut fields = execution_json_fields(execution)?;
    fields.push((
        "execution_digest",
        JsonValue::String(execution.execution_digest.clone()),
    ));
    Ok(object(fields))
}

fn execution_json_without_digest(
    execution: &NativeProjectExecution,
) -> Result<JsonValue, ProjectRuntimeError> {
    Ok(object(execution_json_fields(execution)?))
}

fn execution_json_fields(
    execution: &NativeProjectExecution,
) -> Result<Vec<(&'static str, JsonValue)>, ProjectRuntimeError> {
    let steps = execution
        .steps
        .iter()
        .map(|step| serialize_project_run(step).map(JsonValue::String))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(vec![
        (
            "graph_revision",
            JsonValue::String(execution.graph_revision.clone()),
        ),
        (
            "input_digest",
            JsonValue::String(execution.input_digest.clone()),
        ),
        (
            "plan_digest",
            JsonValue::String(execution.plan_digest.clone()),
        ),
        (
            "profile_digest",
            JsonValue::String(execution.profile_digest.clone()),
        ),
        (
            "project_digest",
            JsonValue::String(execution.project_digest.clone()),
        ),
        ("schema", JsonValue::String(execution.schema.clone())),
        ("steps", JsonValue::Array(steps)),
        (
            "handoffs",
            JsonValue::Array(execution.handoffs.iter().map(handoff_output_json).collect()),
        ),
        (
            "toolchain_digest",
            JsonValue::String(execution.toolchain_digest.clone()),
        ),
    ])
}

fn handoff_output_json(handoff: &NativeProjectExecutionValueHandoff) -> JsonValue {
    object(vec![
        ("from_entry", JsonValue::String(handoff.from_entry.clone())),
        (
            "from_module",
            JsonValue::String(handoff.from_module.clone()),
        ),
        ("to_entry", JsonValue::String(handoff.to_entry.clone())),
        ("to_module", JsonValue::String(handoff.to_module.clone())),
        ("type_name", JsonValue::String(handoff.type_name.clone())),
        ("value", JsonValue::String(handoff.value.clone())),
        (
            "value_digest",
            JsonValue::String(handoff.value_digest.clone()),
        ),
    ])
}

fn validate_handoff_output(
    handoff: &NativeProjectExecutionValueHandoff,
) -> Result<(), ProjectRuntimeError> {
    let value = parse_json(&handoff.value)
        .map_err(|_| ProjectRuntimeError::new("native-project-value-handoff-value-invalid"))?;
    let entries = exact_object(&value, &["type", "value"])
        .map_err(|_| ProjectRuntimeError::new("native-project-value-handoff-value-invalid"))?;
    if required_string(&entries, "type")? != handoff.type_name
        || canonicalize(&value) != handoff.value
        || !valid_digest(&handoff.value_digest)
        || vm_value_digest_from_serialized(&handoff.value) != handoff.value_digest
    {
        return Err(ProjectRuntimeError::new(
            "native-project-value-handoff-value-mismatch",
        ));
    }
    Ok(())
}

fn run_json(run: &NativeProjectRun) -> JsonValue {
    let mut fields = run_fields(run);
    fields.push(("run_digest", JsonValue::String(run.run_digest.clone())));
    object(fields)
}

fn run_json_without_digest(run: &NativeProjectRun) -> JsonValue {
    object(run_fields(run))
}

fn run_fields(run: &NativeProjectRun) -> Vec<(&'static str, JsonValue)> {
    vec![
        (
            "artifact_digest",
            JsonValue::String(run.translation.artifact_digest.clone()),
        ),
        ("build_key", JsonValue::String(run.build_key.clone())),
        (
            "build_manifest_digest",
            JsonValue::String(run.translation.build_manifest_digest.clone()),
        ),
        (
            "graph_revision",
            JsonValue::String(run.graph_revision.clone()),
        ),
        ("input_digest", JsonValue::String(run.input_digest.clone())),
        ("module", JsonValue::String(run.module.clone())),
        (
            "module_artifact_digest",
            JsonValue::String(run.translation.module_artifact_digest.clone()),
        ),
        (
            "module_cache_key",
            JsonValue::String(run.translation.module_cache_key.clone()),
        ),
        (
            "outcome_code",
            JsonValue::Number(run.vm.outcome.code.to_string()),
        ),
        (
            "outcome_type",
            JsonValue::String(run.vm.outcome.type_name.clone()),
        ),
        (
            "project_digest",
            JsonValue::String(run.project_digest.clone()),
        ),
        (
            "project_graph_revision",
            JsonValue::String(run.translation.project_graph_revision.clone()),
        ),
        (
            "profile",
            JsonValue::String(run.translation.profile.clone()),
        ),
        (
            "profile_digest",
            JsonValue::String(run.translation.profile_digest.clone()),
        ),
        ("schema", JsonValue::String(run.schema.clone())),
        (
            "toolchain_digest",
            JsonValue::String(run.translation.toolchain_digest.clone()),
        ),
        (
            "translation_digest",
            JsonValue::String(run.translation.translation_digest.clone()),
        ),
        (
            "vm_receipt_digest",
            JsonValue::String(run.vm.receipt.receipt_digest.clone()),
        ),
    ]
}

fn object(fields: Vec<(&'static str, JsonValue)>) -> JsonValue {
    JsonValue::Object(
        fields
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value))
            .collect(),
    )
}
