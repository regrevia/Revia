use std::{
    fs,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use crate::{
    canonical_json::{JsonValue, canonicalize},
    digest::sha256_hex,
};

pub const RELEASE_CANDIDATE_SCHEMA: &str = "re.native-release-candidate@0.1.0";
pub const RELEASE_LOCK_SCHEMA: &str = "re.native-release-lock@0.1.0";
pub const RELEASE_MATRIX_SCHEMA: &str = "re.native-release-matrix@0.1.0";
pub const RELEASE_VERSION: &str = "1.0.0-rc.2.1";

const NOTICE: &[u8] =
    b"Revia native release candidate\n\nThis artifact is built from the public Revia source tree. It remains a preview candidate and is not a Stable V1.0 release.\n";
const LICENSE: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../LICENSE"));
const TARGETS: [&str; 6] = [
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "windows-arm64",
    "windows-x64",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReleaseError {
    pub code: String,
}

impl ReleaseError {
    pub fn new(code: &str) -> Self {
        Self {
            code: code.to_owned(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PayloadFile {
    name: String,
    bytes: Vec<u8>,
}

pub fn build_release_candidate(
    binary: impl AsRef<Path>,
    output_directory: impl AsRef<Path>,
    target: &str,
    source_inventory_digest: &str,
    toolchain_digest: &str,
) -> Result<String, ReleaseError> {
    validate_inputs(target, source_inventory_digest, toolchain_digest)?;
    let binary = binary.as_ref();
    let binary_bytes = read_regular(binary, "native-release-binary-invalid")?;
    let binary_digest = digest(&binary_bytes);
    let candidate_id = candidate_id(target, &binary_digest);
    let output_directory = output_directory.as_ref();
    if output_directory.exists() {
        return Err(ReleaseError::new("native-release-output-exists"));
    }
    let parent = output_directory
        .parent()
        .ok_or_else(|| ReleaseError::new("native-release-output-parent-invalid"))?;
    fs::create_dir_all(parent)
        .map_err(|_| ReleaseError::new("native-release-output-parent-invalid"))?;
    let temporary = parent.join(format!(
        ".revia-release-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| ReleaseError::new("native-release-temporary-failure"))?
            .as_nanos()
    ));
    fs::create_dir(&temporary)
        .map_err(|_| ReleaseError::new("native-release-temporary-failure"))?;

    let result = (|| {
        let binary_name = binary_name(target);
        let lock = release_lock(
            &candidate_id,
            target,
            &binary_digest,
            source_inventory_digest,
            toolchain_digest,
        );
        let payload = vec![
            PayloadFile {
                name: binary_name.to_owned(),
                bytes: binary_bytes,
            },
            PayloadFile {
                name: "LICENSE".to_owned(),
                bytes: LICENSE.to_vec(),
            },
            PayloadFile {
                name: "NOTICE".to_owned(),
                bytes: NOTICE.to_vec(),
            },
            PayloadFile {
                name: "release-lock.json".to_owned(),
                bytes: lock.as_bytes().to_vec(),
            },
        ];
        for file in &payload {
            write_regular(&temporary.join(&file.name), &file.bytes)?;
        }
        let manifest = manifest(
            &candidate_id,
            target,
            binary_name,
            source_inventory_digest,
            toolchain_digest,
            &payload,
        );
        write_regular(&temporary.join("manifest.json"), manifest.as_bytes())?;
        let checksums = checksums(&payload, manifest.as_bytes());
        write_regular(&temporary.join("checksums.sha256"), checksums.as_bytes())?;
        set_executable(&temporary.join(binary_name))?;
        fs::rename(&temporary, output_directory)
            .map_err(|_| ReleaseError::new("native-release-output-publish-failure"))?;
        Ok(manifest)
    })();
    if result.is_err() {
        fs::remove_dir_all(&temporary).ok();
    }
    result
}

pub fn verify_release_candidate(
    candidate_directory: impl AsRef<Path>,
    target: &str,
    source_inventory_digest: &str,
    toolchain_digest: &str,
) -> Result<String, ReleaseError> {
    validate_inputs(target, source_inventory_digest, toolchain_digest)?;
    let directory = candidate_directory.as_ref();
    ensure_directory(directory, "native-release-candidate-invalid")?;
    let binary_name = binary_name(target);
    let binary_bytes = read_regular(
        &directory.join(binary_name),
        "native-release-binary-invalid",
    )?;
    let binary_digest = digest(&binary_bytes);
    let candidate_id = candidate_id(target, &binary_digest);
    let lock = release_lock(
        &candidate_id,
        target,
        &binary_digest,
        source_inventory_digest,
        toolchain_digest,
    );
    let payload = vec![
        PayloadFile {
            name: binary_name.to_owned(),
            bytes: binary_bytes,
        },
        PayloadFile {
            name: "LICENSE".to_owned(),
            bytes: read_regular(&directory.join("LICENSE"), "native-release-file-invalid")?,
        },
        PayloadFile {
            name: "NOTICE".to_owned(),
            bytes: read_regular(&directory.join("NOTICE"), "native-release-file-invalid")?,
        },
        PayloadFile {
            name: "release-lock.json".to_owned(),
            bytes: read_regular(
                &directory.join("release-lock.json"),
                "native-release-lock-invalid",
            )?,
        },
    ];
    if payload[1].bytes != LICENSE
        || payload[2].bytes != NOTICE
        || payload[3].bytes != lock.as_bytes()
    {
        return Err(ReleaseError::new("native-release-authority-mismatch"));
    }
    let expected_manifest = manifest(
        &candidate_id,
        target,
        binary_name,
        source_inventory_digest,
        toolchain_digest,
        &payload,
    );
    let actual_manifest = read_utf8(
        &directory.join("manifest.json"),
        "native-release-manifest-invalid",
    )?;
    if actual_manifest != expected_manifest {
        return Err(ReleaseError::new("native-release-manifest-mismatch"));
    }
    let expected_checksums = checksums(&payload, expected_manifest.as_bytes());
    let actual_checksums = read_utf8(
        &directory.join("checksums.sha256"),
        "native-release-checksums-invalid",
    )?;
    if actual_checksums != expected_checksums {
        return Err(ReleaseError::new("native-release-checksums-mismatch"));
    }
    validate_file_set(directory, target)?;
    Ok(actual_manifest)
}

pub fn install_release_candidate(
    candidate_directory: impl AsRef<Path>,
    install_root: impl AsRef<Path>,
    target: &str,
    source_inventory_digest: &str,
    toolchain_digest: &str,
) -> Result<String, ReleaseError> {
    let manifest = verify_release_candidate(
        &candidate_directory,
        target,
        source_inventory_digest,
        toolchain_digest,
    )?;
    let candidate_directory = candidate_directory.as_ref();
    let binary_bytes = read_regular(
        &candidate_directory.join(binary_name(target)),
        "native-release-binary-invalid",
    )?;
    let candidate_id = candidate_id(target, &digest(&binary_bytes));
    let install_root = install_root.as_ref();
    ensure_or_create_directory(install_root, "native-release-install-root-invalid")?;
    let versions = install_root.join("versions");
    ensure_or_create_directory(&versions, "native-release-install-root-invalid")?;
    let current_path = install_root.join("current");
    let previous_path = install_root.join("previous");
    let old_current = read_pointer(&current_path)?;
    if let Some(old) = &old_current {
        verify_installed_version(
            &versions.join(old),
            target,
            source_inventory_digest,
            toolchain_digest,
        )
        .map_err(|_| ReleaseError::new("native-release-current-invalid"))?;
    }
    let destination = versions.join(&candidate_id);
    if destination.exists() {
        verify_release_candidate(
            &destination,
            target,
            source_inventory_digest,
            toolchain_digest,
        )
        .map_err(|_| ReleaseError::new("native-release-version-invalid"))?;
    } else {
        let temporary = versions.join(format!(".{}-{}", candidate_id, std::process::id()));
        fs::create_dir(&temporary)
            .map_err(|_| ReleaseError::new("native-release-install-failure"))?;
        if let Err(error) = copy_candidate_files(candidate_directory, &temporary, target) {
            fs::remove_dir_all(&temporary).ok();
            return Err(error);
        }
        if let Err(error) = verify_release_candidate(
            &temporary,
            target,
            source_inventory_digest,
            toolchain_digest,
        ) {
            fs::remove_dir_all(&temporary).ok();
            return Err(ReleaseError::new(&error.code));
        }
        fs::rename(&temporary, &destination)
            .map_err(|_| ReleaseError::new("native-release-install-failure"))?;
    }
    if let Some(old) = old_current {
        write_pointer(&previous_path, &old)?;
    } else {
        remove_if_present(&previous_path)?;
    }
    write_pointer(&current_path, &candidate_id)?;
    Ok(manifest)
}

pub fn rollback_release(
    install_root: impl AsRef<Path>,
    target: &str,
    source_inventory_digest: &str,
    toolchain_digest: &str,
) -> Result<String, ReleaseError> {
    validate_inputs(target, source_inventory_digest, toolchain_digest)?;
    let install_root = install_root.as_ref();
    let versions = install_root.join("versions");
    let current_path = install_root.join("current");
    let previous_path = install_root.join("previous");
    let current = read_pointer(&current_path)?
        .ok_or_else(|| ReleaseError::new("native-release-current-missing"))?;
    let previous = read_pointer(&previous_path)?
        .ok_or_else(|| ReleaseError::new("native-release-previous-missing"))?;
    let current_manifest = verify_installed_version(
        &versions.join(&current),
        target,
        source_inventory_digest,
        toolchain_digest,
    )
    .map_err(|_| ReleaseError::new("native-release-current-invalid"))?;
    verify_installed_version(
        &versions.join(&previous),
        target,
        source_inventory_digest,
        toolchain_digest,
    )
    .map_err(|_| ReleaseError::new("native-release-previous-invalid"))?;
    write_pointer(&previous_path, &current)?;
    write_pointer(&current_path, &previous)?;
    Ok(current_manifest)
}

pub fn serialize_platform_matrix(measured_target: &str) -> Result<String, ReleaseError> {
    validate_target(measured_target)?;
    let platforms = TARGETS
        .iter()
        .map(|target| {
            object(vec![
                ("target", JsonValue::String((*target).to_owned())),
                (
                    "status",
                    JsonValue::String(if *target == measured_target {
                        "measured".to_owned()
                    } else {
                        "pending".to_owned()
                    }),
                ),
                (
                    "reason",
                    JsonValue::String(if *target == measured_target {
                        "darwin-arm64-local-release-gate".to_owned()
                    } else {
                        "runner-not-available".to_owned()
                    }),
                ),
            ])
        })
        .collect();
    Ok(format!(
        "{}\n",
        canonicalize(&object(vec![
            (
                "measured_target",
                JsonValue::String(measured_target.to_owned())
            ),
            ("platforms", JsonValue::Array(platforms)),
            (
                "schema",
                JsonValue::String(RELEASE_MATRIX_SCHEMA.to_owned())
            ),
        ]))
    ))
}

fn validate_inputs(target: &str, source: &str, toolchain: &str) -> Result<(), ReleaseError> {
    validate_target(target)?;
    if !is_digest(source) || !is_digest(toolchain) {
        return Err(ReleaseError::new("native-release-digest-invalid"));
    }
    Ok(())
}

fn validate_target(target: &str) -> Result<(), ReleaseError> {
    if TARGETS.contains(&target) {
        Ok(())
    } else {
        Err(ReleaseError::new("native-release-target-invalid"))
    }
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

fn digest(bytes: &[u8]) -> String {
    format!("sha256:{}", sha256_hex(bytes))
}

fn candidate_id(target: &str, binary_digest: &str) -> String {
    format!("revia-{target}-{}", &binary_digest[7..23])
}

fn binary_name(target: &str) -> &str {
    if target.starts_with("windows-") {
        "revia.exe"
    } else {
        "revia"
    }
}

fn release_lock(
    candidate_id: &str,
    target: &str,
    binary_digest: &str,
    source_inventory_digest: &str,
    toolchain_digest: &str,
) -> String {
    format!(
        "{}\n",
        canonicalize(&object(vec![
            ("binary_digest", JsonValue::String(binary_digest.to_owned())),
            ("candidate_id", JsonValue::String(candidate_id.to_owned())),
            (
                "release_version",
                JsonValue::String(RELEASE_VERSION.to_owned())
            ),
            ("schema", JsonValue::String(RELEASE_LOCK_SCHEMA.to_owned())),
            (
                "source_inventory_digest",
                JsonValue::String(source_inventory_digest.to_owned()),
            ),
            ("target", JsonValue::String(target.to_owned())),
            (
                "toolchain_digest",
                JsonValue::String(toolchain_digest.to_owned())
            ),
        ]))
    )
}

fn manifest(
    candidate_id: &str,
    target: &str,
    binary_name: &str,
    source_inventory_digest: &str,
    toolchain_digest: &str,
    payload: &[PayloadFile],
) -> String {
    let archive_digest = payload_digest(payload);
    let files = payload
        .iter()
        .map(|file| {
            object(vec![
                ("digest", JsonValue::String(digest(&file.bytes))),
                ("path", JsonValue::String(file.name.clone())),
                ("size", JsonValue::Number(file.bytes.len().to_string())),
            ])
        })
        .collect();
    format!(
        "{}\n",
        canonicalize(&object(vec![
            ("archive_digest", JsonValue::String(archive_digest)),
            ("binary", JsonValue::String(binary_name.to_owned())),
            ("candidate_id", JsonValue::String(candidate_id.to_owned())),
            ("files", JsonValue::Array(files)),
            (
                "release_version",
                JsonValue::String(RELEASE_VERSION.to_owned())
            ),
            (
                "schema",
                JsonValue::String(RELEASE_CANDIDATE_SCHEMA.to_owned())
            ),
            (
                "source_inventory_digest",
                JsonValue::String(source_inventory_digest.to_owned()),
            ),
            ("target", JsonValue::String(target.to_owned())),
            (
                "toolchain_digest",
                JsonValue::String(toolchain_digest.to_owned())
            ),
        ]))
    )
}

fn checksums(payload: &[PayloadFile], manifest: &[u8]) -> String {
    let mut lines = payload
        .iter()
        .map(|file| format!("{}  {}", sha256_hex(&file.bytes), file.name))
        .collect::<Vec<_>>();
    lines.push(format!("{}  manifest.json", sha256_hex(manifest)));
    lines.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
    format!("{}\n", lines.join("\n"))
}

fn payload_digest(payload: &[PayloadFile]) -> String {
    let mut files = payload.to_vec();
    files.sort_by(|left, right| left.name.as_bytes().cmp(right.name.as_bytes()));
    let mut bytes = Vec::new();
    for file in files {
        bytes.extend_from_slice(file.name.as_bytes());
        bytes.push(0);
        bytes.extend_from_slice(&(file.bytes.len() as u64).to_be_bytes());
        bytes.extend_from_slice(&file.bytes);
    }
    digest(&bytes)
}

fn object(fields: Vec<(&str, JsonValue)>) -> JsonValue {
    JsonValue::Object(
        fields
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value))
            .collect(),
    )
}

fn ensure_directory(path: &Path, code: &str) -> Result<(), ReleaseError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| ReleaseError::new(code))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        Err(ReleaseError::new(code))
    } else {
        Ok(())
    }
}

fn ensure_or_create_directory(path: &Path, code: &str) -> Result<(), ReleaseError> {
    if path.exists() {
        ensure_directory(path, code)
    } else {
        fs::create_dir_all(path).map_err(|_| ReleaseError::new(code))
    }
}

fn read_regular(path: &Path, code: &str) -> Result<Vec<u8>, ReleaseError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| ReleaseError::new(code))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(ReleaseError::new(code));
    }
    fs::read(path).map_err(|_| ReleaseError::new(code))
}

fn read_utf8(path: &Path, code: &str) -> Result<String, ReleaseError> {
    String::from_utf8(read_regular(path, code)?).map_err(|_| ReleaseError::new(code))
}

fn write_regular(path: &Path, bytes: &[u8]) -> Result<(), ReleaseError> {
    fs::write(path, bytes).map_err(|_| ReleaseError::new("native-release-write-failure"))
}

fn set_executable(path: &Path) -> Result<(), ReleaseError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(path)
            .map_err(|_| ReleaseError::new("native-release-write-failure"))?
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions)
            .map_err(|_| ReleaseError::new("native-release-write-failure"))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn validate_file_set(directory: &Path, target: &str) -> Result<(), ReleaseError> {
    let mut names = fs::read_dir(directory)
        .map_err(|_| ReleaseError::new("native-release-candidate-invalid"))?
        .map(|entry| {
            let entry = entry.map_err(|_| ReleaseError::new("native-release-candidate-invalid"))?;
            let metadata = fs::symlink_metadata(entry.path())
                .map_err(|_| ReleaseError::new("native-release-candidate-invalid"))?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(ReleaseError::new("native-release-extra-file"));
            }
            Ok(entry.file_name().to_string_lossy().into_owned())
        })
        .collect::<Result<Vec<_>, ReleaseError>>()?;
    names.sort();
    let mut expected = vec![
        binary_name(target).to_owned(),
        "LICENSE".to_owned(),
        "NOTICE".to_owned(),
        "checksums.sha256".to_owned(),
        "manifest.json".to_owned(),
        "release-lock.json".to_owned(),
    ];
    expected.sort();
    if names == expected {
        Ok(())
    } else {
        Err(ReleaseError::new("native-release-file-set-invalid"))
    }
}

fn copy_candidate_files(
    source: &Path,
    destination: &Path,
    target: &str,
) -> Result<(), ReleaseError> {
    for name in [
        binary_name(target),
        "LICENSE",
        "NOTICE",
        "release-lock.json",
        "manifest.json",
        "checksums.sha256",
    ] {
        let bytes = read_regular(&source.join(name), "native-release-file-invalid")?;
        write_regular(&destination.join(name), &bytes)?;
    }
    set_executable(&destination.join(binary_name(target)))
}

fn read_pointer(path: &Path) -> Result<Option<String>, ReleaseError> {
    if !path.exists() {
        return Ok(None);
    }
    let value = read_utf8(path, "native-release-pointer-invalid")?;
    if !value.ends_with('\n') {
        return Err(ReleaseError::new("native-release-pointer-invalid"));
    }
    let value = value.trim_end_matches('\n');
    if value.is_empty() || value.contains('/') || value.contains('\\') || value.contains('\n') {
        return Err(ReleaseError::new("native-release-pointer-invalid"));
    }
    Ok(Some(value.to_owned()))
}

fn write_pointer(path: &Path, value: &str) -> Result<(), ReleaseError> {
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    write_regular(&temporary, format!("{value}\n").as_bytes())?;
    fs::rename(&temporary, path)
        .map_err(|_| ReleaseError::new("native-release-pointer-write-failure"))
}

fn remove_if_present(path: &Path) -> Result<(), ReleaseError> {
    if path.exists() {
        let metadata = fs::symlink_metadata(path)
            .map_err(|_| ReleaseError::new("native-release-pointer-invalid"))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(ReleaseError::new("native-release-pointer-invalid"));
        }
        fs::remove_file(path)
            .map_err(|_| ReleaseError::new("native-release-pointer-write-failure"))?;
    }
    Ok(())
}

fn verify_installed_version(
    path: &Path,
    target: &str,
    source_inventory_digest: &str,
    toolchain_digest: &str,
) -> Result<String, ReleaseError> {
    verify_release_candidate(path, target, source_inventory_digest, toolchain_digest)
}
