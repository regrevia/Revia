use std::path::Path;

use crate::{
    canonical_json::{JsonValue, canonicalize},
    digest::sha256_hex,
    project::parse_json,
    project::{NativeBuildResult, NativeProject, build_project, load_project_directory},
    project_runtime::{
        NativeProjectExecution, NativeProjectExecutionPlan, NativeProjectTranslation,
        ProjectRuntimeError, execute_project_execution_plan, serialize_project_execution,
        translate_project_module,
    },
    vm::{CapabilityBridge, VmLimits},
};

pub const NATIVE_MULTI_MODULE_GATE_SCHEMA: &str = "re.native-multi-module-gate@0.1.0";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeMultiModuleEvidence {
    pub artifact_digest: String,
    pub contract_digest: String,
    pub implementation_digest: String,
    pub interface_digest: String,
    pub module: String,
    pub source_sha256: String,
    pub translation_digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeMultiModuleGateReport {
    pub build_key: String,
    pub build_manifest_digest: String,
    pub execution: NativeProjectExecution,
    pub gate_digest: String,
    pub graph_revision: String,
    pub input_digest: String,
    pub modules: Vec<NativeMultiModuleEvidence>,
    pub package_digest: String,
    pub plan_digest: String,
    pub profile_digest: String,
    pub project_digest: String,
    pub schema: String,
    pub toolchain_digest: String,
}

#[allow(clippy::too_many_arguments)]
pub fn execute_native_multi_module_gate(
    project_directory: impl AsRef<Path>,
    cache_directory: impl AsRef<Path>,
    build_directory: impl AsRef<Path>,
    profile_digest: &str,
    toolchain_digest: &str,
    plan: &NativeProjectExecutionPlan,
    input_digest: &str,
    bridge: &mut dyn CapabilityBridge,
    limits: VmLimits,
) -> Result<NativeMultiModuleGateReport, ProjectRuntimeError> {
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
    validate_build_authority(&project, &build, profile_digest, toolchain_digest)?;

    let translations = project
        .modules
        .iter()
        .map(|module| {
            translate_project_module(
                &project_directory,
                &cache_directory,
                &build_directory,
                profile_digest,
                toolchain_digest,
                &module.name,
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    let modules = collect_module_evidence(&project, &build, &translations)?;
    let execution = execute_project_execution_plan(
        project_directory,
        cache_directory,
        build_directory,
        profile_digest,
        toolchain_digest,
        plan,
        input_digest,
        bridge,
        limits,
    )?;
    let mut report = NativeMultiModuleGateReport {
        build_key: build.manifest.build_key.clone(),
        build_manifest_digest: build.manifest.manifest_digest.clone(),
        execution,
        gate_digest: String::new(),
        graph_revision: project.graph_revision.clone(),
        input_digest: input_digest.to_owned(),
        modules,
        package_digest: project.package_digest.clone(),
        plan_digest: crate::project_runtime::project_execution_plan_digest(plan),
        profile_digest: profile_digest.to_owned(),
        project_digest: project.project_digest.clone(),
        schema: NATIVE_MULTI_MODULE_GATE_SCHEMA.to_owned(),
        toolchain_digest: toolchain_digest.to_owned(),
    };
    validate_report_without_digest(&report)?;
    report.gate_digest = gate_digest(&report)?;
    Ok(report)
}

pub fn serialize_native_multi_module_gate_report(
    report: &NativeMultiModuleGateReport,
) -> Result<String, ProjectRuntimeError> {
    validate_report_without_digest(report)?;
    if report.gate_digest != gate_digest(report)? {
        return Err(ProjectRuntimeError::new(
            "native-multi-module-gate-digest-mismatch",
        ));
    }
    Ok(format!("{}\n", canonicalize(&report_json(report, true)?)))
}

fn validate_build_authority(
    project: &NativeProject,
    build: &NativeBuildResult,
    profile_digest: &str,
    toolchain_digest: &str,
) -> Result<(), ProjectRuntimeError> {
    if build.manifest.graph_revision != project.graph_revision
        || build.manifest.package_digest != project.package_digest
        || build.manifest.project_digest != project.project_digest
        || build.manifest.key.profile_digest != profile_digest
        || build.manifest.key.toolchain_digest != toolchain_digest
        || build.manifest.modules.len() != project.modules.len()
    {
        return Err(ProjectRuntimeError::new(
            "native-multi-module-gate-build-authority-mismatch",
        ));
    }
    for module in &project.modules {
        let Some(entry) = build
            .manifest
            .modules
            .iter()
            .find(|candidate| candidate.module == module.name)
        else {
            return Err(ProjectRuntimeError::new(
                "native-multi-module-gate-build-module-missing",
            ));
        };
        if entry.implementation_digest != module.implementation_digest
            || entry.interface_digest != module.interface_digest
        {
            return Err(ProjectRuntimeError::new(
                "native-multi-module-gate-build-module-drift",
            ));
        }
    }
    Ok(())
}

fn collect_module_evidence(
    project: &NativeProject,
    build: &NativeBuildResult,
    translations: &[NativeProjectTranslation],
) -> Result<Vec<NativeMultiModuleEvidence>, ProjectRuntimeError> {
    if translations.len() != project.modules.len() {
        return Err(ProjectRuntimeError::new(
            "native-multi-module-gate-translation-count-mismatch",
        ));
    }
    project
        .modules
        .iter()
        .zip(translations)
        .map(|(module, translation)| {
            let build_module = build
                .manifest
                .modules
                .iter()
                .find(|candidate| candidate.module == module.name)
                .ok_or_else(|| {
                    ProjectRuntimeError::new("native-multi-module-gate-build-module-missing")
                })?;
            if translation.module != module.name
                || translation.project_graph_revision != project.graph_revision
                || translation.project_digest != project.project_digest
                || translation.build_key != build.manifest.build_key
                || translation.build_manifest_digest != build.manifest.manifest_digest
                || translation.module_artifact_digest != build_module.artifact_digest
                || translation.module_cache_key != build_module.cache_key
                || translation.profile_digest != build.manifest.key.profile_digest
                || translation.toolchain_digest != build.manifest.key.toolchain_digest
            {
                return Err(ProjectRuntimeError::new(
                    "native-multi-module-gate-translation-authority-mismatch",
                ));
            }
            let contract_digest = project
                .package_manifest
                .modules
                .iter()
                .find(|candidate| candidate.name == module.name)
                .and_then(|candidate| {
                    candidate
                        .interface
                        .exports
                        .iter()
                        .find(|export| export.kind == "function" && export.name == "main")
                })
                .map(|export| export.contract_digest.clone())
                .ok_or_else(|| {
                    ProjectRuntimeError::new("native-multi-module-gate-contract-missing")
                })?;
            Ok(NativeMultiModuleEvidence {
                artifact_digest: translation.artifact_digest.clone(),
                contract_digest,
                implementation_digest: module.implementation_digest.clone(),
                interface_digest: module.interface_digest.clone(),
                module: module.name.clone(),
                source_sha256: module.source_sha256.clone(),
                translation_digest: translation.translation_digest.clone(),
            })
        })
        .collect()
}

fn validate_report_without_digest(
    report: &NativeMultiModuleGateReport,
) -> Result<(), ProjectRuntimeError> {
    if report.schema != NATIVE_MULTI_MODULE_GATE_SCHEMA
        || report.modules.is_empty()
        || report.execution.graph_revision != report.graph_revision
        || report.execution.input_digest != report.input_digest
        || report.execution.plan_digest != report.plan_digest
        || report.execution.profile_digest != report.profile_digest
        || report.execution.project_digest != report.project_digest
        || report.execution.toolchain_digest != report.toolchain_digest
    {
        return Err(ProjectRuntimeError::new(
            "native-multi-module-gate-authority-mismatch",
        ));
    }
    for digest in [
        &report.build_key,
        &report.build_manifest_digest,
        &report.graph_revision,
        &report.input_digest,
        &report.package_digest,
        &report.plan_digest,
        &report.profile_digest,
        &report.project_digest,
        &report.toolchain_digest,
    ] {
        if !valid_digest(digest) {
            return Err(ProjectRuntimeError::new(
                "native-multi-module-gate-digest-invalid",
            ));
        }
    }
    let mut module_names = std::collections::BTreeSet::new();
    for module in &report.modules {
        for digest in [
            &module.artifact_digest,
            &module.contract_digest,
            &module.implementation_digest,
            &module.interface_digest,
            &module.source_sha256,
            &module.translation_digest,
        ] {
            if !valid_digest(digest) {
                return Err(ProjectRuntimeError::new(
                    "native-multi-module-gate-digest-invalid",
                ));
            }
        }
        if module.module.is_empty() {
            return Err(ProjectRuntimeError::new(
                "native-multi-module-gate-module-invalid",
            ));
        }
        if !module_names.insert(module.module.as_str()) {
            return Err(ProjectRuntimeError::new(
                "native-multi-module-gate-duplicate-module",
            ));
        }
    }
    let _ = serialize_project_execution(&report.execution)?;
    Ok(())
}

fn report_json(
    report: &NativeMultiModuleGateReport,
    include_digest: bool,
) -> Result<JsonValue, ProjectRuntimeError> {
    let modules = report
        .modules
        .iter()
        .map(|module| {
            JsonValue::Object(vec![
                (
                    "artifact_digest".to_owned(),
                    JsonValue::String(module.artifact_digest.clone()),
                ),
                (
                    "contract_digest".to_owned(),
                    JsonValue::String(module.contract_digest.clone()),
                ),
                (
                    "implementation_digest".to_owned(),
                    JsonValue::String(module.implementation_digest.clone()),
                ),
                (
                    "interface_digest".to_owned(),
                    JsonValue::String(module.interface_digest.clone()),
                ),
                (
                    "module".to_owned(),
                    JsonValue::String(module.module.clone()),
                ),
                (
                    "source_sha256".to_owned(),
                    JsonValue::String(module.source_sha256.clone()),
                ),
                (
                    "translation_digest".to_owned(),
                    JsonValue::String(module.translation_digest.clone()),
                ),
            ])
        })
        .collect();
    let execution = crate::project_runtime::serialize_project_execution(&report.execution)?;
    let execution =
        parse_json(&execution).map_err(|error| ProjectRuntimeError::new(&error.code))?;
    let mut fields = vec![
        (
            "build_key".to_owned(),
            JsonValue::String(report.build_key.clone()),
        ),
        (
            "build_manifest_digest".to_owned(),
            JsonValue::String(report.build_manifest_digest.clone()),
        ),
        ("execution".to_owned(), execution),
        (
            "graph_revision".to_owned(),
            JsonValue::String(report.graph_revision.clone()),
        ),
        (
            "input_digest".to_owned(),
            JsonValue::String(report.input_digest.clone()),
        ),
        ("modules".to_owned(), JsonValue::Array(modules)),
        (
            "package_digest".to_owned(),
            JsonValue::String(report.package_digest.clone()),
        ),
        (
            "plan_digest".to_owned(),
            JsonValue::String(report.plan_digest.clone()),
        ),
        (
            "profile_digest".to_owned(),
            JsonValue::String(report.profile_digest.clone()),
        ),
        (
            "project_digest".to_owned(),
            JsonValue::String(report.project_digest.clone()),
        ),
        (
            "schema".to_owned(),
            JsonValue::String(report.schema.clone()),
        ),
        (
            "toolchain_digest".to_owned(),
            JsonValue::String(report.toolchain_digest.clone()),
        ),
    ];
    if include_digest {
        fields.push((
            "gate_digest".to_owned(),
            JsonValue::String(report.gate_digest.clone()),
        ));
    }
    Ok(JsonValue::Object(fields))
}

fn gate_digest(report: &NativeMultiModuleGateReport) -> Result<String, ProjectRuntimeError> {
    Ok(format!(
        "sha256:{}",
        sha256_hex(canonicalize(&report_json(report, false)?).as_bytes())
    ))
}

fn valid_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}
