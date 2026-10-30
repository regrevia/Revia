use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
};

use crate::{
    canonical_json::{JsonValue, canonicalize},
    digest::sha256_hex,
};

pub const PROJECT_MANIFEST_SCHEMA: &str = "re.project-manifest@0.1.0";
pub const PROJECT_GRAPH_SCHEMA: &str = "re.native-project-graph@0.1.0";
pub const BUILD_KEY_SCHEMA: &str = "re.native-project-build-key@0.1.0";
pub const BUILD_MANIFEST_SCHEMA: &str = "re.native-project-build-manifest@0.1.0";
pub const CACHE_KEY_SCHEMA: &str = "re.native-module-artifact-cache-key@0.1.0";
pub const ARTIFACT_SCHEMA: &str = "re.native-module-artifact@0.1.0";
pub const ENTERPRISE_SCALE_SCHEMA: &str = "re.native-enterprise-project-scale@0.1.0";
const DIGEST_PREFIX: &str = "sha256:";
const MAX_JSON_DEPTH: usize = 128;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectError {
    pub code: String,
}

impl ProjectError {
    fn new(code: &str) -> Self {
        Self {
            code: code.to_owned(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeDependency {
    pub binding: String,
    pub interface_digest: String,
    pub module: String,
    pub package_digest: Option<String>,
    pub scope: String,
}

impl NativeDependency {
    pub fn package(
        binding: impl Into<String>,
        interface_digest: impl Into<String>,
        module: impl Into<String>,
    ) -> Self {
        Self {
            binding: binding.into(),
            interface_digest: interface_digest.into(),
            module: module.into(),
            package_digest: None,
            scope: "package".to_owned(),
        }
    }

    pub fn external(
        binding: impl Into<String>,
        interface_digest: impl Into<String>,
        module: impl Into<String>,
        package_digest: impl Into<String>,
    ) -> Self {
        Self {
            binding: binding.into(),
            interface_digest: interface_digest.into(),
            module: module.into(),
            package_digest: Some(package_digest.into()),
            scope: "external".to_owned(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeExport {
    pub contract_digest: String,
    pub kind: String,
    pub name: String,
}

impl NativeExport {
    pub fn function(name: impl Into<String>, contract_digest: impl Into<String>) -> Self {
        Self {
            contract_digest: contract_digest.into(),
            kind: "function".to_owned(),
            name: name.into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeInterface {
    pub dependencies: Vec<NativeDependency>,
    pub exports: Vec<NativeExport>,
    pub module: String,
    pub schema: String,
}

impl NativeInterface {
    pub fn new(
        module: impl Into<String>,
        dependencies: Vec<NativeDependency>,
        exports: Vec<NativeExport>,
    ) -> Self {
        Self {
            dependencies,
            exports,
            module: module.into(),
            schema: "re.module-interface@0.1.0".to_owned(),
        }
    }

    pub fn digest(&self) -> Result<String, ProjectError> {
        Ok(digest_value(&interface_json(self)))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeModule {
    pub implementation_digest: String,
    pub interface: NativeInterface,
    pub interface_digest: String,
    pub name: String,
}

impl NativeModule {
    pub fn new(
        name: impl Into<String>,
        implementation_digest: impl Into<String>,
        interface: NativeInterface,
    ) -> Self {
        let name = name.into();
        let interface_digest = interface.digest().unwrap_or_default();
        Self {
            implementation_digest: implementation_digest.into(),
            interface,
            interface_digest,
            name,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeExternalInterface {
    pub interface: NativeInterface,
    pub interface_digest: String,
    pub module: String,
    pub package_digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativePackage {
    pub external_interfaces: Vec<NativeExternalInterface>,
    pub modules: Vec<NativeModule>,
    pub package: String,
    pub schema: String,
}

impl NativePackage {
    pub fn new(package: impl Into<String>, modules: Vec<NativeModule>) -> Self {
        Self {
            external_interfaces: Vec::new(),
            modules,
            package: package.into(),
            schema: "re.package-manifest@0.1.0".to_owned(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeProjectModule {
    pub name: String,
    pub path: String,
    pub source_sha256: String,
}

impl NativeProjectModule {
    pub fn new(
        name: impl Into<String>,
        path: impl Into<String>,
        source_sha256: impl Into<String>,
    ) -> Self {
        Self {
            name: name.into(),
            path: path.into(),
            source_sha256: source_sha256.into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeProject {
    pub allowed_capabilities: BTreeSet<String>,
    pub graph_revision: String,
    pub modules: Vec<NativeProjectModuleLoaded>,
    pub package: String,
    pub package_digest: String,
    pub package_manifest: NativePackage,
    pub project_digest: String,
    pub resources: Vec<NativeResource>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeResource {
    pub alias: String,
    pub key: String,
    pub uid: String,
}

type ProjectManifestParts = (
    Vec<NativeProjectModule>,
    NativePackage,
    BTreeSet<String>,
    Vec<NativeResource>,
);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeProjectModuleLoaded {
    pub dependencies: Vec<NativeDependency>,
    pub implementation_digest: String,
    pub interface_digest: String,
    pub name: String,
    pub path: String,
    pub source_sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeBuildKey {
    pub build_key: String,
    pub graph_revision: String,
    pub package_digest: String,
    pub profile_digest: String,
    pub project_digest: String,
    pub schema: String,
    pub toolchain_digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeBuildModule {
    pub artifact_digest: String,
    pub cache_key: String,
    pub implementation_digest: String,
    pub interface_digest: String,
    pub module: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeBuildManifest {
    pub build_key: String,
    pub graph_revision: String,
    pub key: NativeBuildKey,
    pub manifest_digest: String,
    pub modules: Vec<NativeBuildModule>,
    pub package_digest: String,
    pub project_digest: String,
    pub schema: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeInvalidation {
    pub added_modules: Vec<String>,
    pub modules: Vec<String>,
    pub removed_modules: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct NativeBuildStats {
    pub built: usize,
    pub hits: usize,
    pub misses: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeBuildResult {
    pub invalidation: NativeInvalidation,
    pub manifest: NativeBuildManifest,
    pub published: bool,
    pub stats: NativeBuildStats,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeEnterpriseProjectScale {
    pub graph_revision: String,
    pub module_count: usize,
    pub public_symbol_count: usize,
    pub route_count: usize,
    pub schema: String,
    pub summary_digest: String,
    pub task_count: usize,
}

pub fn validate_enterprise_project_scale(
    project: &NativeProject,
) -> Result<NativeEnterpriseProjectScale, ProjectError> {
    let module_count = project.modules.len();
    if module_count != 50 {
        return Err(ProjectError::new(
            "enterprise-project-module-count-mismatch",
        ));
    }
    let package_modules = project
        .package_manifest
        .modules
        .iter()
        .map(|module| (module.name.as_str(), module))
        .collect::<BTreeMap<_, _>>();
    let mut route_names = BTreeSet::new();
    let mut task_names = BTreeSet::new();
    let mut public_symbol_count = 0;
    let mut package_edges = 0;
    let mut incoming = BTreeMap::<&str, usize>::new();
    for module in &project.modules {
        let package_module = package_modules
            .get(module.name.as_str())
            .ok_or_else(|| ProjectError::new("enterprise-project-module-missing"))?;
        if package_module.interface_digest != module.interface_digest {
            return Err(ProjectError::new(
                "enterprise-project-interface-digest-mismatch",
            ));
        }
        public_symbol_count += package_module.interface.exports.len();
        for dependency in &package_module.interface.dependencies {
            if dependency.scope == "package" {
                package_edges += 1;
                *incoming.entry(dependency.module.as_str()).or_default() += 1;
            }
        }
        for export in &package_module.interface.exports {
            if export.kind != "function" {
                continue;
            }
            if export.name.starts_with("route_") {
                route_names.insert(export.name.clone());
            } else if export.name.starts_with("task_") {
                task_names.insert(export.name.clone());
            }
        }
    }
    let expected_routes = (0..50)
        .map(|index| format!("route_{index:03}"))
        .collect::<BTreeSet<_>>();
    let expected_tasks = (0..50)
        .map(|index| format!("task_{index:03}"))
        .collect::<BTreeSet<_>>();
    if route_names != expected_routes {
        return Err(ProjectError::new("enterprise-project-route-count-mismatch"));
    }
    if task_names != expected_tasks {
        return Err(ProjectError::new("enterprise-project-task-count-mismatch"));
    }
    if public_symbol_count != 100 {
        return Err(ProjectError::new(
            "enterprise-project-public-symbol-count-mismatch",
        ));
    }
    if package_edges < 49 {
        return Err(ProjectError::new(
            "enterprise-project-dependency-chain-too-short",
        ));
    }
    if !incoming.values().any(|count| *count >= 2) {
        return Err(ProjectError::new("enterprise-project-fan-in-missing"));
    }
    let summary = object(vec![
        (
            "graph_revision",
            JsonValue::String(project.graph_revision.clone()),
        ),
        ("module_count", JsonValue::Number(module_count.to_string())),
        (
            "public_symbol_count",
            JsonValue::Number(public_symbol_count.to_string()),
        ),
        (
            "route_count",
            JsonValue::Number(route_names.len().to_string()),
        ),
        (
            "schema",
            JsonValue::String(ENTERPRISE_SCALE_SCHEMA.to_owned()),
        ),
        (
            "task_count",
            JsonValue::Number(task_names.len().to_string()),
        ),
    ]);
    Ok(NativeEnterpriseProjectScale {
        graph_revision: project.graph_revision.clone(),
        module_count,
        public_symbol_count,
        route_count: route_names.len(),
        schema: ENTERPRISE_SCALE_SCHEMA.to_owned(),
        summary_digest: digest_value(&summary),
        task_count: task_names.len(),
    })
}

pub fn serialize_project_manifest(
    modules: &[NativeProjectModule],
    package: &NativePackage,
) -> Result<String, ProjectError> {
    let modules = modules.iter().map(project_module_json).collect::<Vec<_>>();
    let value = object(vec![
        ("modules", JsonValue::Array(modules)),
        ("package_manifest", package_json(package)),
        (
            "schema",
            JsonValue::String(PROJECT_MANIFEST_SCHEMA.to_owned()),
        ),
    ]);
    Ok(format!("{}\n", canonicalize(&value)))
}

pub fn serialize_project_graph(project: &NativeProject) -> Result<String, ProjectError> {
    let value = object(vec![
        (
            "graph_revision",
            JsonValue::String(project.graph_revision.clone()),
        ),
        (
            "modules",
            JsonValue::Array(
                project
                    .modules
                    .iter()
                    .map(|module| {
                        object(vec![
                            (
                                "dependencies",
                                JsonValue::Array(
                                    module.dependencies.iter().map(dependency_json).collect(),
                                ),
                            ),
                            (
                                "implementation_digest",
                                JsonValue::String(module.implementation_digest.clone()),
                            ),
                            (
                                "interface_digest",
                                JsonValue::String(module.interface_digest.clone()),
                            ),
                            ("name", JsonValue::String(module.name.clone())),
                            ("path", JsonValue::String(module.path.clone())),
                            (
                                "source_sha256",
                                JsonValue::String(module.source_sha256.clone()),
                            ),
                        ])
                    })
                    .collect(),
            ),
        ),
        ("package", JsonValue::String(project.package.clone())),
        (
            "package_digest",
            JsonValue::String(project.package_digest.clone()),
        ),
        (
            "project_digest",
            JsonValue::String(project.project_digest.clone()),
        ),
        ("schema", JsonValue::String(PROJECT_GRAPH_SCHEMA.to_owned())),
    ]);
    Ok(format!("{}\n", canonicalize(&value)))
}

pub fn serialize_build_manifest(manifest: &NativeBuildManifest) -> Result<String, ProjectError> {
    validate_build_manifest(manifest, &manifest.key)?;
    Ok(format!(
        "{}\n",
        canonicalize(&build_manifest_json(manifest))
    ))
}

pub fn package_manifest_digest(package: &NativePackage) -> Result<String, ProjectError> {
    validate_package(package)?;
    Ok(digest_value(&package_json(package)))
}

pub fn load_project_directory(
    root_directory: impl AsRef<Path>,
) -> Result<NativeProject, ProjectError> {
    let root = fs::canonicalize(root_directory.as_ref())
        .map_err(|_| ProjectError::new("project-root-unreadable"))?;
    let manifest_path = root.join("project.json");
    let manifest_source = fs::read_to_string(&manifest_path)
        .map_err(|_| ProjectError::new("project-manifest-unreadable"))?;
    let document = parse_json(&manifest_source)?;
    let (project_modules, package, allowed_capabilities, resources) =
        parse_project_manifest(&document)?;
    validate_package(&package)?;
    validate_project_package_alignment(&project_modules, &package)?;

    let mut declared = BTreeSet::from(["project.json".to_owned()]);
    let mut loaded = Vec::with_capacity(project_modules.len());
    for module in &project_modules {
        validate_relative_path(&module.path)?;
        let source_path = root.join(&module.path);
        let metadata = fs::symlink_metadata(&source_path)
            .map_err(|_| ProjectError::new("project-module-source-missing"))?;
        if metadata.file_type().is_symlink() {
            return Err(ProjectError::new("project-module-symlink-not-allowed"));
        }
        let real_source = fs::canonicalize(&source_path)
            .map_err(|_| ProjectError::new("project-module-source-missing"))?;
        if !real_source.starts_with(&root) {
            return Err(ProjectError::new("project-module-path-escapes-root"));
        }
        let bytes = fs::read(&real_source)
            .map_err(|_| ProjectError::new("project-module-source-unreadable"))?;
        let actual = sha256_digest(&bytes);
        if actual != module.source_sha256 {
            return Err(ProjectError::new("project-module-source-digest-mismatch"));
        }
        declared.insert(module.path.clone());
        let package_module = package
            .modules
            .iter()
            .find(|candidate| candidate.name == module.name)
            .ok_or_else(|| ProjectError::new("project-module-not-in-package-manifest"))?;
        if package_module.implementation_digest != actual {
            return Err(ProjectError::new(
                "project-module-implementation-digest-mismatch",
            ));
        }
        loaded.push(NativeProjectModuleLoaded {
            dependencies: package_module.interface.dependencies.clone(),
            implementation_digest: actual.clone(),
            interface_digest: package_module.interface_digest.clone(),
            name: module.name.clone(),
            path: module.path.clone(),
            source_sha256: actual,
        });
    }
    if let Some(path) = first_unlisted_file(&root, &root, &declared)? {
        return Err(ProjectError::new_with_detail(
            "unlisted-project-file",
            path.to_string_lossy().as_ref(),
        ));
    }

    let order = topological_module_order(&package.modules)?;
    let by_name = loaded
        .into_iter()
        .map(|module| (module.name.clone(), module))
        .collect::<BTreeMap<_, _>>();
    let modules = order
        .into_iter()
        .map(|name| {
            by_name
                .get(&name)
                .cloned()
                .ok_or_else(|| ProjectError::new("project-module-not-in-project-manifest"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let package_digest = package_manifest_digest(&package)?;
    let graph_value = project_graph_json(
        &package,
        &modules,
        &package_digest,
        &allowed_capabilities,
        &resources,
    );
    let graph_revision = digest_value(&graph_value);
    let project_digest = digest_value(&project_identity_json(
        &package,
        &modules,
        &package_digest,
        &allowed_capabilities,
        &resources,
    ));
    Ok(NativeProject {
        allowed_capabilities,
        graph_revision,
        modules,
        package: package.package.clone(),
        package_digest,
        package_manifest: package,
        project_digest,
        resources,
    })
}

pub fn validate_project_module_surfaces(
    root_directory: impl AsRef<Path>,
    project: &NativeProject,
) -> Result<(), ProjectError> {
    for module in &project.modules {
        let source = fs::read_to_string(root_directory.as_ref().join(&module.path))
            .map_err(|_| ProjectError::new("native-project-source-unreadable"))?;
        validate_module_surface(
            &source,
            module,
            &project.package_manifest,
            &project.allowed_capabilities,
            &project.resources,
        )?;
    }
    Ok(())
}

fn validate_module_surface(
    source: &str,
    module: &NativeProjectModuleLoaded,
    package: &NativePackage,
    allowed_capabilities: &BTreeSet<String>,
    resources: &[NativeResource],
) -> Result<(), ProjectError> {
    let lines = source.lines().collect::<Vec<_>>();
    let mut lines_iter = lines.iter().copied();
    if lines_iter.next() != Some("re 1.0 compact") {
        return Err(ProjectError::new(
            "native-project-module-surface-header-unsupported",
        ));
    }
    let declared_capabilities = lines
        .iter()
        .filter_map(|raw| {
            let fields = raw
                .trim()
                .strip_prefix("capability ")?
                .split_whitespace()
                .collect::<Vec<_>>();
            if fields.len() == 5
                && fields[3] == "uid"
                && valid_capability_reference(fields[2])
                && valid_module_uid(fields[4])
            {
                Some((
                    fields[4].to_owned(),
                    fields[1].to_owned(),
                    fields[2].to_owned(),
                ))
            } else {
                None
            }
        })
        .collect::<BTreeSet<_>>();
    let mut saw_module = false;
    let mut imports = BTreeSet::new();
    let mut exports = BTreeSet::new();
    let mut review_uids = BTreeSet::new();
    let package_module = package
        .modules
        .iter()
        .find(|candidate| candidate.name == module.name)
        .ok_or_else(|| ProjectError::new("project-module-not-in-package-manifest"))?;
    for raw in lines_iter {
        let line = raw.trim();
        if line.is_empty() || line.starts_with("//") {
            continue;
        }
        if let Some(name) = line.strip_prefix("module ") {
            if saw_module || name != module.name {
                return Err(ProjectError::new(
                    "native-project-module-surface-module-mismatch",
                ));
            }
            saw_module = true;
            continue;
        }
        if !saw_module {
            return Err(ProjectError::new(
                "native-project-module-surface-module-order-invalid",
            ));
        }
        if let Some(rest) = line.strip_prefix("import ") {
            let (dependency, binding) = rest
                .rsplit_once(" as ")
                .ok_or_else(|| ProjectError::new("native-project-module-surface-import-invalid"))?;
            let (dependency_module, digest) = dependency
                .split_once('@')
                .ok_or_else(|| ProjectError::new("native-project-module-surface-import-invalid"))?;
            if !valid_name(dependency_module) || !valid_binding(binding) || !valid_digest(digest) {
                return Err(ProjectError::new(
                    "native-project-module-surface-import-invalid",
                ));
            }
            let expected = package_module
                .interface
                .dependencies
                .iter()
                .find(|candidate| candidate.binding == binding)
                .ok_or_else(|| {
                    ProjectError::new("native-project-module-surface-import-unlisted")
                })?;
            if expected.module != dependency_module || expected.interface_digest != digest {
                return Err(ProjectError::new(
                    "native-project-module-surface-import-pin-mismatch",
                ));
            }
            if !imports.insert(binding.to_owned()) {
                return Err(ProjectError::new(
                    "native-project-module-surface-import-duplicate",
                ));
            }
            continue;
        }
        if let Some(name) = line.strip_prefix("export ") {
            if !valid_binding(name) {
                return Err(ProjectError::new(
                    "native-project-module-surface-export-invalid",
                ));
            }
            if !package_module
                .interface
                .exports
                .iter()
                .any(|export| export.name == name)
            {
                return Err(ProjectError::new(
                    "native-project-module-surface-export-unlisted",
                ));
            }
            if !exports.insert(name.to_owned()) {
                return Err(ProjectError::new(
                    "native-project-module-surface-export-duplicate",
                ));
            }
            continue;
        }
        validate_module_surface_declaration(
            line,
            &module.name,
            allowed_capabilities,
            resources,
            &declared_capabilities,
            &mut review_uids,
        )?;
    }
    if !saw_module {
        return Err(ProjectError::new(
            "native-project-module-surface-module-missing",
        ));
    }
    let expected_imports = package_module
        .interface
        .dependencies
        .iter()
        .map(|dependency| dependency.binding.clone())
        .collect::<BTreeSet<_>>();
    if imports != expected_imports {
        return Err(ProjectError::new(
            "native-project-module-surface-import-missing",
        ));
    }
    let expected_exports = package_module
        .interface
        .exports
        .iter()
        .map(|export| export.name.clone())
        .collect::<BTreeSet<_>>();
    if exports != expected_exports {
        return Err(ProjectError::new(
            "native-project-module-surface-export-missing",
        ));
    }
    Ok(())
}

fn validate_module_surface_declaration(
    line: &str,
    module: &str,
    allowed_capabilities: &BTreeSet<String>,
    resources: &[NativeResource],
    declared_capabilities: &BTreeSet<(String, String, String)>,
    review_uids: &mut BTreeSet<String>,
) -> Result<(), ProjectError> {
    if let Some(rest) = line.strip_prefix("capability ") {
        let fields = rest.split_whitespace().collect::<Vec<_>>();
        if fields.len() != 5
            || !fields[0].starts_with(&format!("{module}."))
            || !valid_name(fields[0])
            || !valid_binding(fields[1])
            || !valid_capability_reference(fields[2])
            || fields[3] != "uid"
            || !valid_module_uid(fields[4])
        {
            return Err(ProjectError::new(
                "native-project-module-surface-capability-invalid",
            ));
        }
        if !review_uids.insert(fields[4].to_owned()) {
            return Err(ProjectError::new(
                "native-project-module-surface-review-uid-duplicate",
            ));
        }
        if !allowed_capabilities.contains(fields[2]) {
            return Err(ProjectError::new(
                "native-project-module-surface-capability-not-allowed",
            ));
        }
        return Ok(());
    }
    if let Some(rest) = line.strip_prefix("error ") {
        let fields = rest.split_whitespace().collect::<Vec<_>>();
        if fields.len() != 3
            || !fields[0].starts_with(&format!("{module}."))
            || !valid_name(fields[0])
            || fields[1] != "uid"
            || !valid_module_uid(fields[2])
        {
            return Err(ProjectError::new(
                "native-project-module-surface-error-invalid",
            ));
        }
        if !review_uids.insert(fields[2].to_owned()) {
            return Err(ProjectError::new(
                "native-project-module-surface-review-uid-duplicate",
            ));
        }
        return Ok(());
    }
    if let Some(rest) = line.strip_prefix("state ") {
        let fields = rest.split_whitespace().collect::<Vec<_>>();
        if fields.len() != 3
            || !valid_binding(fields[0])
            || fields[1] != "uid"
            || !valid_module_uid(fields[2])
        {
            return Err(ProjectError::new(
                "native-project-module-surface-state-invalid",
            ));
        }
        if !review_uids.insert(fields[2].to_owned()) {
            return Err(ProjectError::new(
                "native-project-module-surface-review-uid-duplicate",
            ));
        }
        return Ok(());
    }
    if let Some(rest) = line.strip_prefix("task ") {
        let fields = rest.split_whitespace().collect::<Vec<_>>();
        if fields.len() != 3
            || !fields[0].starts_with(&format!("{module}."))
            || !valid_name(fields[0])
            || fields[1] != "id"
            || !valid_digest(fields[2])
        {
            return Err(ProjectError::new(
                "native-project-module-surface-task-invalid",
            ));
        }
        return Ok(());
    }
    if let Some(rest) = line.strip_prefix("edge ") {
        let fields = rest.split_whitespace().collect::<Vec<_>>();
        if fields.len() != 5
            || !fields[0].starts_with(&format!("{module}."))
            || !valid_name(fields[0])
            || fields[1] != "->"
            || !fields[2].starts_with(&format!("{module}."))
            || !valid_name(fields[2])
            || fields[3] != "uid"
            || !valid_module_uid(fields[4])
        {
            return Err(ProjectError::new(
                "native-project-module-surface-edge-invalid",
            ));
        }
        if !review_uids.insert(fields[4].to_owned()) {
            return Err(ProjectError::new(
                "native-project-module-surface-review-uid-duplicate",
            ));
        }
        return Ok(());
    }
    for prefix in [
        "type-declaration ",
        "function-declaration ",
        "agent-declaration ",
        "task-contract ",
        "adapter-contract ",
        "run-case ",
    ] {
        if let Some(rest) = line.strip_prefix(prefix) {
            let (name, json) = rest.split_once(' ').ok_or_else(|| {
                ProjectError::new("native-project-module-surface-declaration-invalid")
            })?;
            let name_belongs_to_module = name.starts_with(&format!("{module}."))
                || (prefix == "agent-declaration " && name == module);
            if !name_belongs_to_module || !valid_name(name) || json.is_empty() {
                return Err(ProjectError::new(
                    "native-project-module-surface-declaration-invalid",
                ));
            }
            let value = parse_json(json).map_err(|_| {
                ProjectError::new("native-project-module-surface-declaration-invalid")
            })?;
            if canonicalize(&value) != json {
                return Err(ProjectError::new(
                    "native-project-module-surface-declaration-noncanonical",
                ));
            }
            if prefix == "adapter-contract " {
                validate_adapter_authority(
                    &value,
                    allowed_capabilities,
                    resources,
                    declared_capabilities,
                )?;
            }
            let has_module_owner = matches!(
                &value,
                JsonValue::Object(fields)
                    if fields.iter().any(|(key, value)| {
                        key == "module" && value == &JsonValue::String(module.to_owned())
                    })
            ) || (prefix == "run-case "
                && name.starts_with(&format!("{module}.")));
            if !has_module_owner {
                return Err(ProjectError::new(
                    "native-project-module-surface-declaration-module-mismatch",
                ));
            }
            return Ok(());
        }
    }
    Err(ProjectError::new(
        "native-project-module-surface-construct-unsupported",
    ))
}

fn validate_adapter_authority(
    value: &JsonValue,
    allowed_capabilities: &BTreeSet<String>,
    resources: &[NativeResource],
    declared_capabilities: &BTreeSet<(String, String, String)>,
) -> Result<(), ProjectError> {
    let fields = exact_object(
        value,
        &[
            "agent",
            "cancellation",
            "capability",
            "deadline",
            "error_type",
            "error_variants",
            "features",
            "input_type",
            "module",
            "node_uid",
            "output_type",
            "profile",
            "request_type",
            "resource",
            "schema",
        ],
    )?;
    let capability = fields
        .get("capability")
        .ok_or_else(|| ProjectError::new("native-project-module-surface-adapter-invalid"))?;
    let capability_fields = exact_object(capability, &["instance", "member", "reference"])?;
    let instance = string(&capability_fields, "instance")?;
    let member = string(&capability_fields, "member")?;
    let reference = string(&capability_fields, "reference")?;
    if !allowed_capabilities.contains(reference) {
        return Err(ProjectError::new(
            "native-project-module-surface-capability-not-allowed",
        ));
    }
    let node_uid = string(&fields, "node_uid")?;
    if !declared_capabilities.contains(&(
        node_uid.to_owned(),
        member.to_owned(),
        reference.to_owned(),
    )) {
        return Err(ProjectError::new(
            "native-project-module-surface-adapter-capability-detached",
        ));
    }
    let resource = fields
        .get("resource")
        .ok_or_else(|| ProjectError::new("native-project-module-surface-adapter-invalid"))?;
    let resource_fields = exact_object(resource, &["access", "constructor"])?;
    let access = string(&resource_fields, "access")?;
    let constructor = string(&resource_fields, "constructor")?;
    let declared_resource = resources
        .iter()
        .find(|resource| resource.alias == constructor || resource.key == constructor);
    let Some(declared_resource) = declared_resource else {
        return Err(ProjectError::new(
            "native-project-module-surface-resource-not-declared",
        ));
    };
    let instance_resource = instance.strip_prefix('@');
    if (instance_resource != Some(declared_resource.alias.as_str())
        && instance_resource != Some(declared_resource.key.as_str()))
        || access != member
    {
        return Err(ProjectError::new(
            "native-project-module-surface-resource-mismatch",
        ));
    }
    Ok(())
}

fn valid_capability_reference(value: &str) -> bool {
    let Some((name, version)) = value.rsplit_once('@') else {
        return false;
    };
    let parts = version.split('.').collect::<Vec<_>>();
    valid_name(name)
        && parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
}

fn valid_module_uid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 26
        && bytes[..25]
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || (b'2'..=b'7').contains(byte))
        && matches!(
            bytes[25],
            b'a' | b'e' | b'i' | b'm' | b'q' | b'u' | b'y' | b'4'
        )
}

pub fn plan_project_recheck(
    project: &NativeProject,
    implementation_changed: &[String],
    interface_changed: &[String],
    authority_changed: bool,
) -> Result<Vec<String>, ProjectError> {
    let known = project
        .modules
        .iter()
        .map(|module| module.name.as_str())
        .collect::<BTreeSet<_>>();
    for name in implementation_changed.iter().chain(interface_changed) {
        if !known.contains(name.as_str()) {
            return Err(ProjectError::new("changed-module-not-found"));
        }
    }
    if authority_changed {
        return Ok(project
            .modules
            .iter()
            .map(|module| module.name.clone())
            .collect());
    }
    let mut selected = implementation_changed
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    let mut queue = interface_changed.to_vec();
    selected.extend(interface_changed.iter().cloned());
    while let Some(current) = queue.pop() {
        for module in &project.modules {
            if module
                .dependencies
                .iter()
                .any(|dependency| dependency.scope == "package" && dependency.module == current)
                && selected.insert(module.name.clone())
            {
                queue.push(module.name.clone());
            }
        }
    }
    Ok(project
        .modules
        .iter()
        .filter(|module| selected.contains(&module.name))
        .map(|module| module.name.clone())
        .collect())
}

pub fn create_project_build_key(
    project: &NativeProject,
    profile_digest: &str,
    toolchain_digest: &str,
) -> Result<NativeBuildKey, ProjectError> {
    require_digest(profile_digest)?;
    require_digest(toolchain_digest)?;
    let content = object(vec![
        (
            "graph_revision",
            JsonValue::String(project.graph_revision.clone()),
        ),
        (
            "package_digest",
            JsonValue::String(project.package_digest.clone()),
        ),
        (
            "profile_digest",
            JsonValue::String(profile_digest.to_owned()),
        ),
        (
            "project_digest",
            JsonValue::String(project.project_digest.clone()),
        ),
        ("schema", JsonValue::String(BUILD_KEY_SCHEMA.to_owned())),
        (
            "toolchain_digest",
            JsonValue::String(toolchain_digest.to_owned()),
        ),
    ]);
    let build_key = digest_value(&content);
    Ok(NativeBuildKey {
        build_key,
        graph_revision: project.graph_revision.clone(),
        package_digest: project.package_digest.clone(),
        profile_digest: profile_digest.to_owned(),
        project_digest: project.project_digest.clone(),
        schema: BUILD_KEY_SCHEMA.to_owned(),
        toolchain_digest: toolchain_digest.to_owned(),
    })
}

pub fn build_project(
    project_directory: impl AsRef<Path>,
    cache_directory: impl AsRef<Path>,
    build_directory: impl AsRef<Path>,
    profile_digest: &str,
    toolchain_digest: &str,
    previous_manifest: Option<&NativeBuildManifest>,
) -> Result<NativeBuildResult, ProjectError> {
    let project = load_project_directory(project_directory)?;
    let key = create_project_build_key(&project, profile_digest, toolchain_digest)?;
    let invalidation = create_invalidation(
        &project,
        previous_manifest,
        profile_digest,
        toolchain_digest,
        build_directory.as_ref(),
    )?;
    let mut stats = NativeBuildStats::default();
    let mut artifacts = Vec::with_capacity(project.modules.len());
    for module in &project.modules {
        let cache_key = create_module_cache_key(module, profile_digest, toolchain_digest)?;
        let cache_path = cache_directory
            .as_ref()
            .join(cache_key.cache_key.trim_start_matches(DIGEST_PREFIX))
            .join("artifact.json");
        let artifact = match read_artifact(&cache_path, &cache_key) {
            Ok(Some(artifact)) => {
                stats.hits += 1;
                artifact
            }
            Ok(None) => {
                stats.misses += 1;
                let artifact = create_artifact(&cache_key, module)?;
                let replayed = write_artifact(&cache_path, &artifact)?;
                if replayed {
                    stats.hits += 1;
                } else {
                    stats.built += 1;
                }
                artifact
            }
            Err(error) => return Err(error),
        };
        artifacts.push(artifact);
    }
    let manifest = create_build_manifest(&project, &key, &artifacts)?;
    let manifest_path = build_directory
        .as_ref()
        .join(manifest.build_key.trim_start_matches(DIGEST_PREFIX))
        .join("build.json");
    let published = write_build_manifest(&manifest_path, &manifest)?;
    Ok(NativeBuildResult {
        invalidation,
        manifest,
        published,
        stats,
    })
}

fn create_invalidation(
    project: &NativeProject,
    previous: Option<&NativeBuildManifest>,
    profile_digest: &str,
    toolchain_digest: &str,
    build_directory: &Path,
) -> Result<NativeInvalidation, ProjectError> {
    let Some(previous) = previous else {
        return Ok(NativeInvalidation {
            added_modules: project
                .modules
                .iter()
                .map(|module| module.name.clone())
                .collect(),
            modules: project
                .modules
                .iter()
                .map(|module| module.name.clone())
                .collect(),
            removed_modules: Vec::new(),
        });
    };
    validate_build_manifest(previous, &previous.key)?;
    let previous_path = build_directory
        .join(previous.build_key.trim_start_matches(DIGEST_PREFIX))
        .join("build.json");
    let published = read_build_manifest(&previous_path, &previous.key)?;
    if published != *previous {
        return Err(ProjectError::new(
            "project-build-previous-manifest-mismatch",
        ));
    }
    let current = project
        .modules
        .iter()
        .map(|module| module.name.clone())
        .collect::<BTreeSet<_>>();
    let previous_by_name = previous
        .modules
        .iter()
        .map(|module| (module.module.as_str(), module))
        .collect::<BTreeMap<_, _>>();
    let added_modules = project
        .modules
        .iter()
        .filter(|module| !previous_by_name.contains_key(module.name.as_str()))
        .map(|module| module.name.clone())
        .collect::<Vec<_>>();
    let removed_modules = previous
        .modules
        .iter()
        .filter(|module| !current.contains(module.module.as_str()))
        .map(|module| module.module.clone())
        .collect::<Vec<_>>();
    let authority_changed = previous.key.profile_digest != profile_digest
        || previous.key.toolchain_digest != toolchain_digest;
    let mut implementation = Vec::new();
    let mut interface = added_modules.clone();
    for module in &project.modules {
        let Some(old) = previous_by_name.get(module.name.as_str()) else {
            continue;
        };
        if authority_changed || old.interface_digest != module.interface_digest {
            interface.push(module.name.clone());
        } else if old.implementation_digest != module.implementation_digest {
            implementation.push(module.name.clone());
        }
    }
    let modules = plan_project_recheck(project, &implementation, &interface, authority_changed)?;
    Ok(NativeInvalidation {
        added_modules,
        modules,
        removed_modules,
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct NativeCacheKey {
    cache_key: String,
    dependencies: Vec<NativeDependency>,
    implementation_digest: String,
    interface_digest: String,
    module: String,
    profile_digest: String,
    schema: String,
    toolchain_digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct NativeArtifact {
    artifact_digest: String,
    cache_key: String,
    key: NativeCacheKey,
    payload_digest: String,
    payload: JsonValue,
    schema: String,
}

fn create_module_cache_key(
    module: &NativeProjectModuleLoaded,
    profile_digest: &str,
    toolchain_digest: &str,
) -> Result<NativeCacheKey, ProjectError> {
    require_digest(profile_digest)?;
    require_digest(toolchain_digest)?;
    let mut dependencies = module.dependencies.clone();
    dependencies.sort_by(|left, right| left.binding.as_bytes().cmp(right.binding.as_bytes()));
    let content = cache_key_content_json(&NativeCacheKey {
        cache_key: String::new(),
        dependencies: dependencies.clone(),
        implementation_digest: module.implementation_digest.clone(),
        interface_digest: module.interface_digest.clone(),
        module: module.name.clone(),
        profile_digest: profile_digest.to_owned(),
        schema: CACHE_KEY_SCHEMA.to_owned(),
        toolchain_digest: toolchain_digest.to_owned(),
    });
    Ok(NativeCacheKey {
        cache_key: digest_value(&content),
        dependencies,
        implementation_digest: module.implementation_digest.clone(),
        interface_digest: module.interface_digest.clone(),
        module: module.name.clone(),
        profile_digest: profile_digest.to_owned(),
        schema: CACHE_KEY_SCHEMA.to_owned(),
        toolchain_digest: toolchain_digest.to_owned(),
    })
}

fn create_artifact(
    key: &NativeCacheKey,
    module: &NativeProjectModuleLoaded,
) -> Result<NativeArtifact, ProjectError> {
    let payload = object(vec![
        (
            "dependencies",
            JsonValue::Array(key.dependencies.iter().map(dependency_json).collect()),
        ),
        (
            "implementation_digest",
            JsonValue::String(module.implementation_digest.clone()),
        ),
        (
            "interface_digest",
            JsonValue::String(module.interface_digest.clone()),
        ),
        ("module", JsonValue::String(module.name.clone())),
    ]);
    let payload_digest = digest_value(&payload);
    let content = object(vec![
        ("cache_key", JsonValue::String(key.cache_key.clone())),
        ("key", cache_key_json(key)),
        ("payload", payload.clone()),
        ("payload_digest", JsonValue::String(payload_digest.clone())),
        ("schema", JsonValue::String(ARTIFACT_SCHEMA.to_owned())),
    ]);
    Ok(NativeArtifact {
        artifact_digest: digest_value(&content),
        cache_key: key.cache_key.clone(),
        key: key.clone(),
        payload_digest,
        payload,
        schema: ARTIFACT_SCHEMA.to_owned(),
    })
}

fn read_artifact(
    path: &Path,
    expected: &NativeCacheKey,
) -> Result<Option<NativeArtifact>, ProjectError> {
    let source = match fs::read_to_string(path) {
        Ok(source) => source,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(ProjectError::new("module-artifact-cache-read-failure")),
    };
    let value =
        parse_json(&source).map_err(|_| ProjectError::new("module-artifact-cache-corrupt"))?;
    let artifact =
        parse_artifact(&value).map_err(|_| ProjectError::new("module-artifact-cache-corrupt"))?;
    validate_artifact(&artifact, expected)
        .map_err(|_| ProjectError::new("module-artifact-cache-semantic-mismatch"))?;
    Ok(Some(artifact))
}

fn write_artifact(path: &Path, artifact: &NativeArtifact) -> Result<bool, ProjectError> {
    let directory = path
        .parent()
        .ok_or_else(|| ProjectError::new("module-artifact-cache-write-failure"))?;
    let cache_root = directory
        .parent()
        .ok_or_else(|| ProjectError::new("module-artifact-cache-write-failure"))?;
    fs::create_dir_all(cache_root)
        .map_err(|_| ProjectError::new("module-artifact-cache-cache-root-create-failure"))?;
    let final_directory = directory;
    let nonce = format!(".tmp-{}-{}", std::process::id(), unique_nonce());
    let temporary = cache_root.join(nonce);
    fs::create_dir(&temporary).map_err(|_| {
        ProjectError::new("module-artifact-cache-temporary-directory-create-failure")
    })?;
    let temporary_file = temporary.join("artifact.json");
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_file)
            .map_err(|_| {
                ProjectError::new("module-artifact-cache-temporary-file-create-failure")
            })?;
        file.write_all(format!("{}\n", canonicalize(&artifact_json(artifact))).as_bytes())
            .map_err(|_| ProjectError::new("module-artifact-cache-temporary-file-write-failure"))?;
        drop(file);
        match fs::rename(&temporary, final_directory) {
            Ok(()) => Ok(false),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::AlreadyExists | std::io::ErrorKind::DirectoryNotEmpty
                ) =>
            {
                let existing = read_artifact(path, &artifact.key)?
                    .ok_or_else(|| ProjectError::new("module-artifact-cache-nondeterministic"))?;
                if canonicalize(&artifact_json(&existing)) == canonicalize(&artifact_json(artifact))
                {
                    Ok(true)
                } else {
                    Err(ProjectError::new("module-artifact-cache-nondeterministic"))
                }
            }
            Err(_) => Err(ProjectError::new(
                "module-artifact-cache-directory-publish-failure",
            )),
        }
    })();
    if temporary.exists() {
        let _ = fs::remove_dir_all(&temporary);
    }
    result
}

fn create_build_manifest(
    project: &NativeProject,
    key: &NativeBuildKey,
    artifacts: &[NativeArtifact],
) -> Result<NativeBuildManifest, ProjectError> {
    if artifacts.len() != project.modules.len() {
        return Err(ProjectError::new("invalid-project-build-manifest"));
    }
    let by_name = artifacts
        .iter()
        .map(|artifact| (artifact.key.module.as_str(), artifact))
        .collect::<BTreeMap<_, _>>();
    let modules = project
        .modules
        .iter()
        .map(|module| {
            let artifact = by_name
                .get(module.name.as_str())
                .ok_or_else(|| ProjectError::new("project-build-artifact-module-mismatch"))?;
            Ok(NativeBuildModule {
                artifact_digest: artifact.artifact_digest.clone(),
                cache_key: artifact.cache_key.clone(),
                implementation_digest: module.implementation_digest.clone(),
                interface_digest: module.interface_digest.clone(),
                module: module.name.clone(),
            })
        })
        .collect::<Result<Vec<_>, ProjectError>>()?;
    let content = object(vec![
        ("build_key", JsonValue::String(key.build_key.clone())),
        (
            "graph_revision",
            JsonValue::String(project.graph_revision.clone()),
        ),
        ("key", build_key_json(key)),
        (
            "modules",
            JsonValue::Array(modules.iter().map(build_module_json).collect()),
        ),
        (
            "package_digest",
            JsonValue::String(project.package_digest.clone()),
        ),
        (
            "project_digest",
            JsonValue::String(project.project_digest.clone()),
        ),
        (
            "schema",
            JsonValue::String(BUILD_MANIFEST_SCHEMA.to_owned()),
        ),
    ]);
    Ok(NativeBuildManifest {
        build_key: key.build_key.clone(),
        graph_revision: project.graph_revision.clone(),
        key: key.clone(),
        manifest_digest: digest_value(&content),
        modules,
        package_digest: project.package_digest.clone(),
        project_digest: project.project_digest.clone(),
        schema: BUILD_MANIFEST_SCHEMA.to_owned(),
    })
}

fn write_build_manifest(path: &Path, manifest: &NativeBuildManifest) -> Result<bool, ProjectError> {
    let directory = path
        .parent()
        .ok_or_else(|| ProjectError::new("project-build-manifest-write-failure"))?;
    let build_root = directory
        .parent()
        .ok_or_else(|| ProjectError::new("project-build-manifest-write-failure"))?;
    fs::create_dir_all(build_root)
        .map_err(|_| ProjectError::new("project-build-manifest-root-create-failure"))?;
    let temporary = build_root.join(format!(".tmp-{}-{}", std::process::id(), unique_nonce()));
    fs::create_dir(&temporary).map_err(|_| {
        ProjectError::new("project-build-manifest-temporary-directory-create-failure")
    })?;
    let temporary_file = temporary.join("build.json");
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_file)
            .map_err(|_| {
                ProjectError::new("project-build-manifest-temporary-file-create-failure")
            })?;
        file.write_all(format!("{}\n", canonicalize(&build_manifest_json(manifest))).as_bytes())
            .map_err(|_| {
                ProjectError::new("project-build-manifest-temporary-file-write-failure")
            })?;
        drop(file);
        match fs::rename(&temporary, directory) {
            Ok(()) => Ok(true),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::AlreadyExists | std::io::ErrorKind::DirectoryNotEmpty
                ) =>
            {
                let existing = read_build_manifest(path, &manifest.key)?;
                if existing == *manifest {
                    Ok(false)
                } else {
                    Err(ProjectError::new("project-build-manifest-nondeterministic"))
                }
            }
            Err(_) => Err(ProjectError::new(
                "project-build-manifest-directory-publish-failure",
            )),
        }
    })();
    if temporary.exists() {
        let _ = fs::remove_dir_all(&temporary);
    }
    result
}

fn read_build_manifest(
    path: &Path,
    key: &NativeBuildKey,
) -> Result<NativeBuildManifest, ProjectError> {
    let source = fs::read_to_string(path)
        .map_err(|_| ProjectError::new("project-build-previous-manifest-mismatch"))?;
    let value = parse_json(&source)
        .map_err(|_| ProjectError::new("project-build-previous-manifest-mismatch"))?;
    let manifest = parse_build_manifest(&value)
        .map_err(|_| ProjectError::new("project-build-previous-manifest-mismatch"))?;
    validate_build_manifest(&manifest, key)
        .map_err(|_| ProjectError::new("project-build-previous-manifest-mismatch"))?;
    Ok(manifest)
}

fn validate_build_manifest(
    manifest: &NativeBuildManifest,
    expected_key: &NativeBuildKey,
) -> Result<(), ProjectError> {
    if manifest.schema != BUILD_MANIFEST_SCHEMA
        || manifest.key != *expected_key
        || manifest.build_key != expected_key.build_key
        || manifest.graph_revision != expected_key.graph_revision
        || manifest.package_digest != expected_key.package_digest
        || manifest.project_digest != expected_key.project_digest
        || manifest.manifest_digest != digest_value(&build_manifest_content(manifest))
    {
        return Err(ProjectError::new("invalid-project-build-manifest"));
    }
    Ok(())
}

fn validate_artifact(
    artifact: &NativeArtifact,
    expected_key: &NativeCacheKey,
) -> Result<(), ProjectError> {
    if artifact.schema != ARTIFACT_SCHEMA
        || artifact.key != *expected_key
        || artifact.cache_key != expected_key.cache_key
        || artifact.payload_digest != digest_value(&artifact.payload)
        || artifact.artifact_digest != digest_value(&artifact_content(artifact))
        || artifact.payload
            != object(vec![
                (
                    "dependencies",
                    JsonValue::Array(
                        expected_key
                            .dependencies
                            .iter()
                            .map(dependency_json)
                            .collect(),
                    ),
                ),
                (
                    "implementation_digest",
                    JsonValue::String(expected_key.implementation_digest.clone()),
                ),
                (
                    "interface_digest",
                    JsonValue::String(expected_key.interface_digest.clone()),
                ),
                ("module", JsonValue::String(expected_key.module.clone())),
            ])
    {
        return Err(ProjectError::new("invalid-module-artifact"));
    }
    Ok(())
}

fn parse_project_manifest(value: &JsonValue) -> Result<ProjectManifestParts, ProjectError> {
    let entries = exact_object(
        value,
        &[
            "agents",
            "allowed_capabilities",
            "modules",
            "package_manifest",
            "resources",
            "schema",
        ],
    )
    .map_err(|error| {
        if error.code == "unexpected-project-field" {
            ProjectError::new("unexpected-project-manifest-field")
        } else {
            error
        }
    })?;
    if string(&entries, "schema")? != PROJECT_MANIFEST_SCHEMA {
        return Err(ProjectError::new("unsupported-project-manifest"));
    }
    if let Some(value) = entries.get("agents")
        && !matches!(value, JsonValue::Array(_))
    {
        return Err(ProjectError::new("invalid-project-agent-set"));
    }
    let allowed_capabilities = if let Some(JsonValue::Array(values)) =
        entries.get("allowed_capabilities")
    {
        let mut capabilities = BTreeSet::new();
        for value in values {
            let capability = match value {
                JsonValue::String(value) => value,
                _ => return Err(ProjectError::new("invalid-project-allowed-capability")),
            };
            if !valid_capability_reference(capability) || !capabilities.insert(capability.clone()) {
                return Err(ProjectError::new("invalid-project-allowed-capability"));
            }
        }
        capabilities
    } else if entries.contains_key("allowed_capabilities") {
        return Err(ProjectError::new("invalid-project-allowed-capabilities"));
    } else {
        BTreeSet::new()
    };
    let resources = entries
        .get("resources")
        .map(|value| parse_resources(value))
        .transpose()?
        .unwrap_or_default();
    let modules = array(&entries, "modules")?
        .iter()
        .map(parse_project_module)
        .collect::<Result<Vec<_>, _>>()?;
    if modules.is_empty() {
        return Err(ProjectError::new("invalid-project-module-set"));
    }
    let package = parse_package(
        entries
            .get("package_manifest")
            .ok_or_else(|| ProjectError::new("missing-project-package-manifest"))?,
    )?;
    Ok((modules, package, allowed_capabilities, resources))
}

fn parse_resources(value: &JsonValue) -> Result<Vec<NativeResource>, ProjectError> {
    let JsonValue::Array(values) = value else {
        return Err(ProjectError::new("invalid-project-resource-set"));
    };
    let mut resources = Vec::new();
    let mut aliases = BTreeSet::new();
    let mut keys = BTreeSet::new();
    let mut uids = BTreeSet::new();
    for value in values {
        let entries = exact_object(value, &["alias", "key", "uid"])?;
        let resource = NativeResource {
            alias: string(&entries, "alias")?.to_owned(),
            key: string(&entries, "key")?.to_owned(),
            uid: string(&entries, "uid")?.to_owned(),
        };
        if !valid_binding(&resource.alias)
            || !valid_binding(&resource.key)
            || !valid_module_uid(&resource.uid)
            || !aliases.insert(resource.alias.clone())
            || !keys.insert(resource.key.clone())
            || !uids.insert(resource.uid.clone())
        {
            return Err(ProjectError::new("invalid-project-resource"));
        }
        resources.push(resource);
    }
    resources.sort_by(|left, right| left.alias.as_bytes().cmp(right.alias.as_bytes()));
    Ok(resources)
}

fn parse_project_module(value: &JsonValue) -> Result<NativeProjectModule, ProjectError> {
    let entries = exact_object(value, &["name", "path", "source_sha256"])?;
    Ok(NativeProjectModule {
        name: string(&entries, "name")?.to_owned(),
        path: string(&entries, "path")?.to_owned(),
        source_sha256: string(&entries, "source_sha256")?.to_owned(),
    })
}

fn parse_package(value: &JsonValue) -> Result<NativePackage, ProjectError> {
    let entries = exact_object(
        value,
        &["external_interfaces", "modules", "package", "schema"],
    )?;
    if string(&entries, "schema")? != "re.package-manifest@0.1.0" {
        return Err(ProjectError::new("unsupported-package-manifest"));
    }
    let modules = array(&entries, "modules")?
        .iter()
        .map(parse_package_module)
        .collect::<Result<Vec<_>, _>>()?;
    let external_interfaces = array(&entries, "external_interfaces")?
        .iter()
        .map(parse_external_interface)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(NativePackage {
        external_interfaces,
        modules,
        package: string(&entries, "package")?.to_owned(),
        schema: string(&entries, "schema")?.to_owned(),
    })
}

fn parse_package_module(value: &JsonValue) -> Result<NativeModule, ProjectError> {
    let entries = exact_object(
        value,
        &[
            "implementation_digest",
            "interface",
            "interface_digest",
            "name",
        ],
    )?;
    let interface = parse_interface(
        entries
            .get("interface")
            .ok_or_else(|| ProjectError::new("unsupported-module-interface"))?,
    )?;
    Ok(NativeModule {
        implementation_digest: string(&entries, "implementation_digest")?.to_owned(),
        interface_digest: string(&entries, "interface_digest")?.to_owned(),
        name: string(&entries, "name")?.to_owned(),
        interface,
    })
}

fn parse_external_interface(value: &JsonValue) -> Result<NativeExternalInterface, ProjectError> {
    let entries = exact_object(
        value,
        &["interface", "interface_digest", "module", "package_digest"],
    )?;
    Ok(NativeExternalInterface {
        interface: parse_interface(
            entries
                .get("interface")
                .ok_or_else(|| ProjectError::new("unsupported-module-interface"))?,
        )?,
        interface_digest: string(&entries, "interface_digest")?.to_owned(),
        module: string(&entries, "module")?.to_owned(),
        package_digest: string(&entries, "package_digest")?.to_owned(),
    })
}

fn parse_interface(value: &JsonValue) -> Result<NativeInterface, ProjectError> {
    let entries = exact_object(value, &["dependencies", "exports", "module", "schema"])?;
    let dependencies = array(&entries, "dependencies")?
        .iter()
        .map(parse_dependency)
        .collect::<Result<Vec<_>, _>>()?;
    let exports = array(&entries, "exports")?
        .iter()
        .map(parse_export)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(NativeInterface {
        dependencies,
        exports,
        module: string(&entries, "module")?.to_owned(),
        schema: string(&entries, "schema")?.to_owned(),
    })
}

fn parse_dependency(value: &JsonValue) -> Result<NativeDependency, ProjectError> {
    let raw = exact_object(
        value,
        &[
            "binding",
            "interface_digest",
            "module",
            "package_digest",
            "scope",
        ],
    )?;
    let scope = string(&raw, "scope")?.to_owned();
    let package_digest = match scope.as_str() {
        "package" => {
            if raw.contains_key("package_digest") {
                return Err(ProjectError::new("unexpected-module-dependency-field"));
            }
            None
        }
        "external" => Some(string(&raw, "package_digest")?.to_owned()),
        _ => return Err(ProjectError::new("invalid-module-dependency-scope")),
    };
    Ok(NativeDependency {
        binding: string(&raw, "binding")?.to_owned(),
        interface_digest: string(&raw, "interface_digest")?.to_owned(),
        module: string(&raw, "module")?.to_owned(),
        package_digest,
        scope,
    })
}

fn parse_export(value: &JsonValue) -> Result<NativeExport, ProjectError> {
    let raw = exact_object(value, &["contract_digest", "kind", "name"])?;
    Ok(NativeExport {
        contract_digest: string(&raw, "contract_digest")?.to_owned(),
        kind: string(&raw, "kind")?.to_owned(),
        name: string(&raw, "name")?.to_owned(),
    })
}

fn validate_package(package: &NativePackage) -> Result<(), ProjectError> {
    if package.schema != "re.package-manifest@0.1.0" || !valid_name(&package.package) {
        return Err(ProjectError::new("invalid-package-name"));
    }
    let mut module_names = BTreeSet::new();
    for module in &package.modules {
        if !valid_name(&module.name)
            || module.name != module.interface.module
            || !valid_digest(&module.implementation_digest)
            || !valid_digest(&module.interface_digest)
            || !module_names.insert(module.name.clone())
        {
            return Err(ProjectError::new("invalid-package-module"));
        }
        validate_interface(&module.interface)?;
    }
    topological_module_order(&package.modules)?;
    let mut modules = BTreeSet::new();
    for module in &package.modules {
        if !valid_name(&module.name)
            || module.name != module.interface.module
            || !valid_digest(&module.implementation_digest)
            || !valid_digest(&module.interface_digest)
            || module.interface.digest()? != module.interface_digest
        {
            return Err(ProjectError::new("module-interface-digest-mismatch"));
        }
        if !modules.insert(module.name.clone()) {
            return Err(ProjectError::new("duplicate-module"));
        }
        validate_interface(&module.interface)?;
    }
    let mut external = BTreeSet::new();
    for entry in &package.external_interfaces {
        if !valid_name(&entry.module)
            || entry.interface.module != entry.module
            || !valid_digest(&entry.package_digest)
            || !valid_digest(&entry.interface_digest)
            || entry.interface.digest()? != entry.interface_digest
            || !external.insert(format!("{}\0{}", entry.package_digest, entry.module))
        {
            return Err(ProjectError::new("invalid-external-interface"));
        }
        validate_interface(&entry.interface)?;
    }
    for module in &package.modules {
        for dependency in &module.interface.dependencies {
            if !valid_binding(&dependency.binding)
                || !valid_name(&dependency.module)
                || !valid_digest(&dependency.interface_digest)
            {
                return Err(ProjectError::new("invalid-module-dependency"));
            }
            match dependency.scope.as_str() {
                "package" => {
                    let target = package
                        .modules
                        .iter()
                        .find(|candidate| candidate.name == dependency.module)
                        .ok_or_else(|| ProjectError::new("package-dependency-not-found"))?;
                    if target.interface_digest != dependency.interface_digest {
                        return Err(ProjectError::new("package-dependency-interface-mismatch"));
                    }
                }
                "external" => {
                    let package_digest = dependency
                        .package_digest
                        .as_deref()
                        .ok_or_else(|| ProjectError::new("invalid-dependency-package-digest"))?;
                    if !valid_digest(package_digest)
                        || !package.external_interfaces.iter().any(|candidate| {
                            candidate.module == dependency.module
                                && candidate.package_digest == package_digest
                                && candidate.interface_digest == dependency.interface_digest
                        })
                    {
                        return Err(ProjectError::new("external-dependency-not-found"));
                    }
                }
                _ => return Err(ProjectError::new("invalid-module-dependency-scope")),
            }
        }
    }
    Ok(())
}

fn validate_interface(interface: &NativeInterface) -> Result<(), ProjectError> {
    if interface.schema != "re.module-interface@0.1.0"
        || !valid_name(&interface.module)
        || interface.exports.iter().any(|export| {
            !valid_binding(&export.name)
                || !valid_digest(&export.contract_digest)
                || !matches!(export.kind.as_str(), "function" | "type" | "value")
        })
    {
        return Err(ProjectError::new("invalid-module-interface"));
    }
    let mut exports = BTreeSet::new();
    if interface
        .exports
        .iter()
        .any(|export| !exports.insert(export.name.clone()))
    {
        return Err(ProjectError::new("duplicate-module-export"));
    }
    let mut dependencies = BTreeSet::new();
    if interface
        .dependencies
        .iter()
        .any(|dependency| !dependencies.insert(dependency.binding.clone()))
    {
        return Err(ProjectError::new("duplicate-module-binding"));
    }
    Ok(())
}

fn validate_project_package_alignment(
    project_modules: &[NativeProjectModule],
    package: &NativePackage,
) -> Result<(), ProjectError> {
    let mut project_names = BTreeSet::new();
    let mut project_paths = BTreeSet::new();
    for module in project_modules {
        if !project_names.insert(module.name.as_str()) {
            return Err(ProjectError::new("duplicate-project-module"));
        }
        if !project_paths.insert(module.path.as_str()) {
            return Err(ProjectError::new("duplicate-project-module-path"));
        }
    }
    let package_names = package
        .modules
        .iter()
        .map(|module| module.name.as_str())
        .collect::<BTreeSet<_>>();
    if project_names != package_names {
        return Err(ProjectError::new("project-package-module-set-mismatch"));
    }
    for module in project_modules {
        if !valid_name(&module.name) || !valid_digest(&module.source_sha256) {
            return Err(ProjectError::new("invalid-project-module"));
        }
    }
    Ok(())
}

fn topological_module_order(modules: &[NativeModule]) -> Result<Vec<String>, ProjectError> {
    let by_name = modules
        .iter()
        .map(|module| (module.name.as_str(), module))
        .collect::<BTreeMap<_, _>>();
    let mut remaining = modules
        .iter()
        .map(|module| {
            (
                module.name.clone(),
                module
                    .interface
                    .dependencies
                    .iter()
                    .filter(|dependency| dependency.scope == "package")
                    .count(),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let mut ready = remaining
        .iter()
        .filter(|(_, count)| **count == 0)
        .map(|(name, _)| name.clone())
        .collect::<Vec<_>>();
    ready.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
    let mut order = Vec::with_capacity(modules.len());
    while let Some(name) = ready.first().cloned() {
        ready.remove(0);
        order.push(name.clone());
        for module in modules {
            if module
                .interface
                .dependencies
                .iter()
                .any(|dependency| dependency.scope == "package" && dependency.module == name)
            {
                let count = remaining
                    .get_mut(&module.name)
                    .ok_or_else(|| ProjectError::new("module-dependency-cycle"))?;
                *count -= 1;
                if *count == 0 {
                    ready.push(module.name.clone());
                    ready.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
                }
            }
        }
    }
    if order.len() != by_name.len() {
        return Err(ProjectError::new("module-dependency-cycle"));
    }
    Ok(order)
}

fn project_graph_json(
    package: &NativePackage,
    modules: &[NativeProjectModuleLoaded],
    package_digest: &str,
    allowed_capabilities: &BTreeSet<String>,
    resources: &[NativeResource],
) -> JsonValue {
    let mut entries = vec![
        (
            "modules",
            JsonValue::Array(
                modules
                    .iter()
                    .map(|module| {
                        object(vec![
                            (
                                "dependencies",
                                JsonValue::Array(
                                    module.dependencies.iter().map(dependency_json).collect(),
                                ),
                            ),
                            (
                                "implementation_digest",
                                JsonValue::String(module.implementation_digest.clone()),
                            ),
                            (
                                "interface_digest",
                                JsonValue::String(module.interface_digest.clone()),
                            ),
                            ("name", JsonValue::String(module.name.clone())),
                            ("path", JsonValue::String(module.path.clone())),
                            (
                                "source_sha256",
                                JsonValue::String(module.source_sha256.clone()),
                            ),
                        ])
                    })
                    .collect(),
            ),
        ),
        ("package", JsonValue::String(package.package.clone())),
        (
            "package_digest",
            JsonValue::String(package_digest.to_owned()),
        ),
        ("schema", JsonValue::String(PROJECT_GRAPH_SCHEMA.to_owned())),
    ];
    if !allowed_capabilities.is_empty() {
        entries.push((
            "allowed_capabilities",
            JsonValue::Array(
                allowed_capabilities
                    .iter()
                    .cloned()
                    .map(JsonValue::String)
                    .collect(),
            ),
        ));
    }
    if !resources.is_empty() {
        entries.push((
            "resources",
            JsonValue::Array(resources.iter().map(resource_json).collect()),
        ));
    }
    object(entries)
}

fn project_identity_json(
    package: &NativePackage,
    modules: &[NativeProjectModuleLoaded],
    package_digest: &str,
    allowed_capabilities: &BTreeSet<String>,
    resources: &[NativeResource],
) -> JsonValue {
    let mut entries = vec![
        (
            "modules",
            JsonValue::Array(
                modules
                    .iter()
                    .map(|module| {
                        object(vec![
                            ("name", JsonValue::String(module.name.clone())),
                            ("path", JsonValue::String(module.path.clone())),
                            (
                                "source_sha256",
                                JsonValue::String(module.source_sha256.clone()),
                            ),
                            (
                                "interface_digest",
                                JsonValue::String(module.interface_digest.clone()),
                            ),
                        ])
                    })
                    .collect(),
            ),
        ),
        ("package", JsonValue::String(package.package.clone())),
        (
            "package_digest",
            JsonValue::String(package_digest.to_owned()),
        ),
    ];
    if !allowed_capabilities.is_empty() {
        entries.push((
            "allowed_capabilities",
            JsonValue::Array(
                allowed_capabilities
                    .iter()
                    .cloned()
                    .map(JsonValue::String)
                    .collect(),
            ),
        ));
    }
    if !resources.is_empty() {
        entries.push((
            "resources",
            JsonValue::Array(resources.iter().map(resource_json).collect()),
        ));
    }
    object(entries)
}

fn resource_json(resource: &NativeResource) -> JsonValue {
    object(vec![
        ("alias", JsonValue::String(resource.alias.clone())),
        ("key", JsonValue::String(resource.key.clone())),
        ("uid", JsonValue::String(resource.uid.clone())),
    ])
}

fn package_json(package: &NativePackage) -> JsonValue {
    let mut modules = package.modules.clone();
    modules.sort_by(|left, right| left.name.as_bytes().cmp(right.name.as_bytes()));
    let mut external = package.external_interfaces.clone();
    external.sort_by(|left, right| {
        format!("{}\0{}", left.package_digest, left.module)
            .as_bytes()
            .cmp(format!("{}\0{}", right.package_digest, right.module).as_bytes())
    });
    object(vec![
        (
            "external_interfaces",
            JsonValue::Array(external.iter().map(external_json).collect()),
        ),
        (
            "modules",
            JsonValue::Array(modules.iter().map(package_module_json).collect()),
        ),
        ("package", JsonValue::String(package.package.clone())),
        ("schema", JsonValue::String(package.schema.clone())),
    ])
}

fn package_module_json(module: &NativeModule) -> JsonValue {
    object(vec![
        (
            "implementation_digest",
            JsonValue::String(module.implementation_digest.clone()),
        ),
        ("interface", interface_json(&module.interface)),
        (
            "interface_digest",
            JsonValue::String(module.interface_digest.clone()),
        ),
        ("name", JsonValue::String(module.name.clone())),
    ])
}

fn external_json(entry: &NativeExternalInterface) -> JsonValue {
    object(vec![
        ("interface", interface_json(&entry.interface)),
        (
            "interface_digest",
            JsonValue::String(entry.interface_digest.clone()),
        ),
        ("module", JsonValue::String(entry.module.clone())),
        (
            "package_digest",
            JsonValue::String(entry.package_digest.clone()),
        ),
    ])
}

fn interface_json(interface: &NativeInterface) -> JsonValue {
    let mut dependencies = interface.dependencies.clone();
    dependencies.sort_by(|left, right| left.binding.as_bytes().cmp(right.binding.as_bytes()));
    let mut exports = interface.exports.clone();
    exports.sort_by(|left, right| left.name.as_bytes().cmp(right.name.as_bytes()));
    object(vec![
        (
            "dependencies",
            JsonValue::Array(dependencies.iter().map(dependency_json).collect()),
        ),
        (
            "exports",
            JsonValue::Array(exports.iter().map(export_json).collect()),
        ),
        ("module", JsonValue::String(interface.module.clone())),
        ("schema", JsonValue::String(interface.schema.clone())),
    ])
}

fn dependency_json(dependency: &NativeDependency) -> JsonValue {
    let mut fields = vec![
        ("binding", JsonValue::String(dependency.binding.clone())),
        (
            "interface_digest",
            JsonValue::String(dependency.interface_digest.clone()),
        ),
        ("module", JsonValue::String(dependency.module.clone())),
    ];
    if let Some(package_digest) = &dependency.package_digest {
        fields.push(("package_digest", JsonValue::String(package_digest.clone())));
    }
    fields.push(("scope", JsonValue::String(dependency.scope.clone())));
    object(fields)
}

fn export_json(export: &NativeExport) -> JsonValue {
    object(vec![
        (
            "contract_digest",
            JsonValue::String(export.contract_digest.clone()),
        ),
        ("kind", JsonValue::String(export.kind.clone())),
        ("name", JsonValue::String(export.name.clone())),
    ])
}

fn project_module_json(module: &NativeProjectModule) -> JsonValue {
    object(vec![
        ("name", JsonValue::String(module.name.clone())),
        ("path", JsonValue::String(module.path.clone())),
        (
            "source_sha256",
            JsonValue::String(module.source_sha256.clone()),
        ),
    ])
}

fn cache_key_json(key: &NativeCacheKey) -> JsonValue {
    object(vec![
        ("cache_key", JsonValue::String(key.cache_key.clone())),
        (
            "dependencies",
            JsonValue::Array(key.dependencies.iter().map(dependency_json).collect()),
        ),
        (
            "implementation_digest",
            JsonValue::String(key.implementation_digest.clone()),
        ),
        (
            "interface_digest",
            JsonValue::String(key.interface_digest.clone()),
        ),
        ("module", JsonValue::String(key.module.clone())),
        (
            "profile_digest",
            JsonValue::String(key.profile_digest.clone()),
        ),
        ("schema", JsonValue::String(key.schema.clone())),
        (
            "toolchain_digest",
            JsonValue::String(key.toolchain_digest.clone()),
        ),
    ])
}

fn cache_key_content_json(key: &NativeCacheKey) -> JsonValue {
    let mut value = cache_key_json(key);
    if let JsonValue::Object(entries) = &mut value {
        entries.retain(|(name, _)| name != "cache_key");
    }
    value
}

fn artifact_json(artifact: &NativeArtifact) -> JsonValue {
    object(vec![
        (
            "artifact_digest",
            JsonValue::String(artifact.artifact_digest.clone()),
        ),
        ("cache_key", JsonValue::String(artifact.cache_key.clone())),
        ("key", cache_key_json(&artifact.key)),
        ("payload", artifact.payload.clone()),
        (
            "payload_digest",
            JsonValue::String(artifact.payload_digest.clone()),
        ),
        ("schema", JsonValue::String(artifact.schema.clone())),
    ])
}

fn artifact_content(artifact: &NativeArtifact) -> JsonValue {
    object(vec![
        ("cache_key", JsonValue::String(artifact.cache_key.clone())),
        ("key", cache_key_json(&artifact.key)),
        ("payload", artifact.payload.clone()),
        (
            "payload_digest",
            JsonValue::String(artifact.payload_digest.clone()),
        ),
        ("schema", JsonValue::String(artifact.schema.clone())),
    ])
}

fn build_key_json(key: &NativeBuildKey) -> JsonValue {
    object(vec![
        ("build_key", JsonValue::String(key.build_key.clone())),
        (
            "graph_revision",
            JsonValue::String(key.graph_revision.clone()),
        ),
        (
            "package_digest",
            JsonValue::String(key.package_digest.clone()),
        ),
        (
            "profile_digest",
            JsonValue::String(key.profile_digest.clone()),
        ),
        (
            "project_digest",
            JsonValue::String(key.project_digest.clone()),
        ),
        ("schema", JsonValue::String(key.schema.clone())),
        (
            "toolchain_digest",
            JsonValue::String(key.toolchain_digest.clone()),
        ),
    ])
}

fn build_module_json(module: &NativeBuildModule) -> JsonValue {
    object(vec![
        (
            "artifact_digest",
            JsonValue::String(module.artifact_digest.clone()),
        ),
        ("cache_key", JsonValue::String(module.cache_key.clone())),
        (
            "implementation_digest",
            JsonValue::String(module.implementation_digest.clone()),
        ),
        (
            "interface_digest",
            JsonValue::String(module.interface_digest.clone()),
        ),
        ("module", JsonValue::String(module.module.clone())),
    ])
}

fn build_manifest_json(manifest: &NativeBuildManifest) -> JsonValue {
    object(vec![
        ("build_key", JsonValue::String(manifest.build_key.clone())),
        (
            "graph_revision",
            JsonValue::String(manifest.graph_revision.clone()),
        ),
        ("key", build_key_json(&manifest.key)),
        (
            "manifest_digest",
            JsonValue::String(manifest.manifest_digest.clone()),
        ),
        (
            "modules",
            JsonValue::Array(manifest.modules.iter().map(build_module_json).collect()),
        ),
        (
            "package_digest",
            JsonValue::String(manifest.package_digest.clone()),
        ),
        (
            "project_digest",
            JsonValue::String(manifest.project_digest.clone()),
        ),
        ("schema", JsonValue::String(manifest.schema.clone())),
    ])
}

fn build_manifest_content(manifest: &NativeBuildManifest) -> JsonValue {
    let mut value = build_manifest_json(manifest);
    if let JsonValue::Object(entries) = &mut value {
        entries.retain(|(key, _)| key != "manifest_digest");
    }
    value
}

fn parse_artifact(value: &JsonValue) -> Result<NativeArtifact, ProjectError> {
    let entries = exact_object(
        value,
        &[
            "artifact_digest",
            "cache_key",
            "key",
            "payload",
            "payload_digest",
            "schema",
        ],
    )?;
    let key = parse_cache_key(
        entries
            .get("key")
            .ok_or_else(|| ProjectError::new("invalid-module-artifact"))?,
    )?;
    Ok(NativeArtifact {
        artifact_digest: string(&entries, "artifact_digest")?.to_owned(),
        cache_key: string(&entries, "cache_key")?.to_owned(),
        key,
        payload: entries
            .get("payload")
            .cloned()
            .ok_or_else(|| ProjectError::new("invalid-module-artifact"))?
            .clone(),
        payload_digest: string(&entries, "payload_digest")?.to_owned(),
        schema: string(&entries, "schema")?.to_owned(),
    })
}

fn parse_cache_key(value: &JsonValue) -> Result<NativeCacheKey, ProjectError> {
    let entries = exact_object(
        value,
        &[
            "cache_key",
            "dependencies",
            "implementation_digest",
            "interface_digest",
            "module",
            "profile_digest",
            "schema",
            "toolchain_digest",
        ],
    )?;
    Ok(NativeCacheKey {
        cache_key: string(&entries, "cache_key")?.to_owned(),
        dependencies: array(&entries, "dependencies")?
            .iter()
            .map(parse_dependency)
            .collect::<Result<Vec<_>, _>>()?,
        implementation_digest: string(&entries, "implementation_digest")?.to_owned(),
        interface_digest: string(&entries, "interface_digest")?.to_owned(),
        module: string(&entries, "module")?.to_owned(),
        profile_digest: string(&entries, "profile_digest")?.to_owned(),
        schema: string(&entries, "schema")?.to_owned(),
        toolchain_digest: string(&entries, "toolchain_digest")?.to_owned(),
    })
}

fn parse_build_manifest(value: &JsonValue) -> Result<NativeBuildManifest, ProjectError> {
    let entries = exact_object(
        value,
        &[
            "build_key",
            "graph_revision",
            "key",
            "manifest_digest",
            "modules",
            "package_digest",
            "project_digest",
            "schema",
        ],
    )?;
    let key = parse_build_key(
        entries
            .get("key")
            .ok_or_else(|| ProjectError::new("invalid-project-build-manifest"))?,
    )?;
    let modules = array(&entries, "modules")?
        .iter()
        .map(|value| {
            let entry = exact_object(
                value,
                &[
                    "artifact_digest",
                    "cache_key",
                    "implementation_digest",
                    "interface_digest",
                    "module",
                ],
            )?;
            Ok(NativeBuildModule {
                artifact_digest: string(&entry, "artifact_digest")?.to_owned(),
                cache_key: string(&entry, "cache_key")?.to_owned(),
                implementation_digest: string(&entry, "implementation_digest")?.to_owned(),
                interface_digest: string(&entry, "interface_digest")?.to_owned(),
                module: string(&entry, "module")?.to_owned(),
            })
        })
        .collect::<Result<Vec<_>, ProjectError>>()?;
    Ok(NativeBuildManifest {
        build_key: string(&entries, "build_key")?.to_owned(),
        graph_revision: string(&entries, "graph_revision")?.to_owned(),
        key,
        manifest_digest: string(&entries, "manifest_digest")?.to_owned(),
        modules,
        package_digest: string(&entries, "package_digest")?.to_owned(),
        project_digest: string(&entries, "project_digest")?.to_owned(),
        schema: string(&entries, "schema")?.to_owned(),
    })
}

fn parse_build_key(value: &JsonValue) -> Result<NativeBuildKey, ProjectError> {
    let entries = exact_object(
        value,
        &[
            "build_key",
            "graph_revision",
            "package_digest",
            "profile_digest",
            "project_digest",
            "schema",
            "toolchain_digest",
        ],
    )?;
    Ok(NativeBuildKey {
        build_key: string(&entries, "build_key")?.to_owned(),
        graph_revision: string(&entries, "graph_revision")?.to_owned(),
        package_digest: string(&entries, "package_digest")?.to_owned(),
        profile_digest: string(&entries, "profile_digest")?.to_owned(),
        project_digest: string(&entries, "project_digest")?.to_owned(),
        schema: string(&entries, "schema")?.to_owned(),
        toolchain_digest: string(&entries, "toolchain_digest")?.to_owned(),
    })
}

pub(crate) fn exact_object<'a>(
    value: &'a JsonValue,
    expected: &[&str],
) -> Result<BTreeMap<String, &'a JsonValue>, ProjectError> {
    let JsonValue::Object(entries) = value else {
        return Err(ProjectError::new("invalid-json-object"));
    };
    let expected = expected.iter().copied().collect::<BTreeSet<_>>();
    let mut result = BTreeMap::new();
    for (key, value) in entries {
        if !expected.contains(key.as_str()) {
            return Err(ProjectError::new("unexpected-project-field"));
        }
        if result.insert(key.clone(), value).is_some() {
            return Err(ProjectError::new("duplicate-json-field"));
        }
    }
    Ok(result)
}

pub(crate) fn string<'a>(
    entries: &'a BTreeMap<String, &'a JsonValue>,
    name: &str,
) -> Result<&'a str, ProjectError> {
    match entries.get(name) {
        Some(JsonValue::String(value)) => Ok(value),
        _ => Err(ProjectError::new("invalid-project-field")),
    }
}

pub(crate) fn array<'a>(
    entries: &'a BTreeMap<String, &'a JsonValue>,
    name: &str,
) -> Result<&'a [JsonValue], ProjectError> {
    match entries.get(name) {
        Some(JsonValue::Array(value)) => Ok(value),
        _ => Err(ProjectError::new("invalid-project-field")),
    }
}

fn object(entries: Vec<(&str, JsonValue)>) -> JsonValue {
    JsonValue::Object(
        entries
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value))
            .collect(),
    )
}

fn digest_value(value: &JsonValue) -> String {
    sha256_digest(canonicalize(value).as_bytes())
}

fn sha256_digest(bytes: &[u8]) -> String {
    format!("{DIGEST_PREFIX}{}", sha256_hex(bytes))
}

fn require_digest(value: &str) -> Result<(), ProjectError> {
    if valid_digest(value) {
        Ok(())
    } else {
        Err(ProjectError::new("invalid-digest"))
    }
}

fn valid_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with(DIGEST_PREFIX)
        && value[DIGEST_PREFIX.len()..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
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

fn validate_relative_path(value: &str) -> Result<(), ProjectError> {
    if value.is_empty() || value.contains('\\') {
        return Err(ProjectError::new("project-module-path-escapes-root"));
    }
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::RootDir))
    {
        return Err(ProjectError::new("project-module-path-escapes-root"));
    }
    Ok(())
}

fn first_unlisted_file(
    root: &Path,
    directory: &Path,
    declared: &BTreeSet<String>,
) -> Result<Option<PathBuf>, ProjectError> {
    let mut entries = fs::read_dir(directory)
        .map_err(|_| ProjectError::new("project-root-unreadable"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| ProjectError::new("project-root-unreadable"))?;
    entries.sort_by_key(|left| left.file_name());
    for entry in entries {
        let path = entry.path();
        let relative = path
            .strip_prefix(root)
            .map_err(|_| ProjectError::new("project-root-unreadable"))?
            .to_string_lossy()
            .replace('\\', "/");
        let file_type = entry
            .file_type()
            .map_err(|_| ProjectError::new("project-root-unreadable"))?;
        if file_type.is_dir() {
            if let Some(found) = first_unlisted_file(root, &path, declared)? {
                return Ok(Some(found));
            }
        } else if !declared.contains(&relative) && !is_project_metadata(&relative) {
            return Ok(Some(path));
        }
    }
    Ok(None)
}

fn is_project_metadata(relative: &str) -> bool {
    matches!(
        relative,
        "HANDOFF.md" | "README.md" | "interface-routes.json"
    )
}

fn unique_nonce() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0)
}

impl ProjectError {
    fn new_with_detail(_code: &str, _detail: &str) -> Self {
        Self::new(_code)
    }
}

pub fn parse_json(source: &str) -> Result<JsonValue, ProjectError> {
    let mut parser = JsonParser {
        bytes: source.as_bytes(),
        index: 0,
        depth: 0,
    };
    let value = parser.value()?;
    parser.whitespace();
    if parser.index != parser.bytes.len() {
        return Err(ProjectError::new("project-manifest-json-invalid"));
    }
    Ok(value)
}

struct JsonParser<'a> {
    bytes: &'a [u8],
    index: usize,
    depth: usize,
}

impl<'a> JsonParser<'a> {
    fn value(&mut self) -> Result<JsonValue, ProjectError> {
        self.whitespace();
        if self.depth > MAX_JSON_DEPTH {
            return Err(ProjectError::new("json-depth-limit"));
        }
        match self.bytes.get(self.index).copied() {
            Some(b'n') => self.literal(b"null", JsonValue::Null),
            Some(b't') => self.literal(b"true", JsonValue::Bool(true)),
            Some(b'f') => self.literal(b"false", JsonValue::Bool(false)),
            Some(b'"') => Ok(JsonValue::String(self.string()?)),
            Some(b'[') => self.array(),
            Some(b'{') => self.object(),
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => Err(ProjectError::new("project-manifest-json-invalid")),
        }
    }

    fn literal(&mut self, expected: &[u8], value: JsonValue) -> Result<JsonValue, ProjectError> {
        if self.bytes.get(self.index..self.index + expected.len()) == Some(expected) {
            self.index += expected.len();
            Ok(value)
        } else {
            Err(ProjectError::new("project-manifest-json-invalid"))
        }
    }

    fn array(&mut self) -> Result<JsonValue, ProjectError> {
        self.index += 1;
        self.depth += 1;
        let mut values = Vec::new();
        self.whitespace();
        if self.consume(b']') {
            self.depth -= 1;
            return Ok(JsonValue::Array(values));
        }
        loop {
            values.push(self.value()?);
            self.whitespace();
            if self.consume(b']') {
                self.depth -= 1;
                return Ok(JsonValue::Array(values));
            }
            if !self.consume(b',') {
                return Err(ProjectError::new("project-manifest-json-invalid"));
            }
        }
    }

    fn object(&mut self) -> Result<JsonValue, ProjectError> {
        self.index += 1;
        self.depth += 1;
        let mut entries = Vec::new();
        let mut keys = BTreeSet::new();
        self.whitespace();
        if self.consume(b'}') {
            self.depth -= 1;
            return Ok(JsonValue::Object(entries));
        }
        loop {
            self.whitespace();
            if self.bytes.get(self.index).is_none_or(|byte| *byte != b'"') {
                return Err(ProjectError::new("project-manifest-json-invalid"));
            }
            let key = self.string()?;
            if !keys.insert(key.clone()) {
                return Err(ProjectError::new("duplicate-json-field"));
            }
            self.whitespace();
            if !self.consume(b':') {
                return Err(ProjectError::new("project-manifest-json-invalid"));
            }
            entries.push((key, self.value()?));
            self.whitespace();
            if self.consume(b'}') {
                self.depth -= 1;
                return Ok(JsonValue::Object(entries));
            }
            if !self.consume(b',') {
                return Err(ProjectError::new("project-manifest-json-invalid"));
            }
        }
    }

    fn string(&mut self) -> Result<String, ProjectError> {
        if !self.consume(b'"') {
            return Err(ProjectError::new("project-manifest-json-invalid"));
        }
        let mut output = String::new();
        while let Some(byte) = self.bytes.get(self.index).copied() {
            self.index += 1;
            match byte {
                b'"' => return Ok(output),
                b'\\' => {
                    let escaped = self
                        .bytes
                        .get(self.index)
                        .copied()
                        .ok_or_else(|| ProjectError::new("project-manifest-json-invalid"))?;
                    self.index += 1;
                    match escaped {
                        b'"' => output.push('"'),
                        b'\\' => output.push('\\'),
                        b'/' => output.push('/'),
                        b'b' => output.push('\u{0008}'),
                        b'f' => output.push('\u{000c}'),
                        b'n' => output.push('\n'),
                        b'r' => output.push('\r'),
                        b't' => output.push('\t'),
                        b'u' => output.push(self.unicode_escape()?),
                        _ => return Err(ProjectError::new("project-manifest-json-invalid")),
                    }
                }
                0..=0x1f => return Err(ProjectError::new("project-manifest-json-invalid")),
                _ => {
                    let start = self.index - 1;
                    let character = std::str::from_utf8(
                        self.bytes
                            .get(start..)
                            .ok_or_else(|| ProjectError::new("project-manifest-json-invalid"))?,
                    )
                    .map_err(|_| ProjectError::new("project-manifest-json-invalid"))?
                    .chars()
                    .next()
                    .ok_or_else(|| ProjectError::new("project-manifest-json-invalid"))?;
                    output.push(character);
                    self.index = start + character.len_utf8();
                }
            }
        }
        Err(ProjectError::new("project-manifest-json-invalid"))
    }

    fn unicode_escape(&mut self) -> Result<char, ProjectError> {
        let value = self.hex4()?;
        if (0xd800..=0xdbff).contains(&value) {
            if self.bytes.get(self.index..self.index + 2) != Some(b"\\u") {
                return Err(ProjectError::new("project-manifest-json-invalid"));
            }
            self.index += 2;
            let low = self.hex4()?;
            if !(0xdc00..=0xdfff).contains(&low) {
                return Err(ProjectError::new("project-manifest-json-invalid"));
            }
            let code = 0x1_0000 + ((value - 0xd800) << 10) + (low - 0xdc00);
            char::from_u32(code).ok_or_else(|| ProjectError::new("project-manifest-json-invalid"))
        } else if (0xdc00..=0xdfff).contains(&value) {
            Err(ProjectError::new("project-manifest-json-invalid"))
        } else {
            char::from_u32(value).ok_or_else(|| ProjectError::new("project-manifest-json-invalid"))
        }
    }

    fn hex4(&mut self) -> Result<u32, ProjectError> {
        let bytes = self
            .bytes
            .get(self.index..self.index + 4)
            .ok_or_else(|| ProjectError::new("project-manifest-json-invalid"))?;
        self.index += 4;
        let mut value = 0;
        for byte in bytes {
            value = value * 16
                + match byte {
                    b'0'..=b'9' => u32::from(byte - b'0'),
                    b'a'..=b'f' => u32::from(byte - b'a' + 10),
                    b'A'..=b'F' => u32::from(byte - b'A' + 10),
                    _ => return Err(ProjectError::new("project-manifest-json-invalid")),
                };
        }
        Ok(value)
    }

    fn number(&mut self) -> Result<JsonValue, ProjectError> {
        let start = self.index;
        self.consume(b'-');
        match self.bytes.get(self.index).copied() {
            Some(b'0') => {
                self.index += 1;
                if self
                    .bytes
                    .get(self.index)
                    .is_some_and(|byte| byte.is_ascii_digit())
                {
                    return Err(ProjectError::new("project-manifest-json-invalid"));
                }
            }
            Some(b'1'..=b'9') => {
                self.index += 1;
                while self
                    .bytes
                    .get(self.index)
                    .is_some_and(|byte| byte.is_ascii_digit())
                {
                    self.index += 1;
                }
            }
            _ => return Err(ProjectError::new("project-manifest-json-invalid")),
        }
        if self.consume(b'.') {
            let digits = self.index;
            while self
                .bytes
                .get(self.index)
                .is_some_and(|byte| byte.is_ascii_digit())
            {
                self.index += 1;
            }
            if digits == self.index {
                return Err(ProjectError::new("project-manifest-json-invalid"));
            }
        }
        if self
            .bytes
            .get(self.index)
            .is_some_and(|byte| *byte == b'e' || *byte == b'E')
        {
            self.index += 1;
            self.consume(b'+');
            self.consume(b'-');
            let digits = self.index;
            while self
                .bytes
                .get(self.index)
                .is_some_and(|byte| byte.is_ascii_digit())
            {
                self.index += 1;
            }
            if digits == self.index {
                return Err(ProjectError::new("project-manifest-json-invalid"));
            }
        }
        let value = std::str::from_utf8(&self.bytes[start..self.index])
            .map_err(|_| ProjectError::new("project-manifest-json-invalid"))?;
        Ok(JsonValue::Number(value.to_owned()))
    }

    fn whitespace(&mut self) {
        while self
            .bytes
            .get(self.index)
            .is_some_and(|byte| matches!(byte, b' ' | b'\n' | b'\r' | b'\t'))
        {
            self.index += 1;
        }
    }

    fn consume(&mut self, expected: u8) -> bool {
        if self.bytes.get(self.index) == Some(&expected) {
            self.index += 1;
            true
        } else {
            false
        }
    }
}
