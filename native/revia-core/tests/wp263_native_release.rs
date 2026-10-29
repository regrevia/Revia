use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use revia_core::release::{
    ReleaseError, build_release_candidate, install_release_candidate, rollback_release,
    serialize_platform_matrix, verify_release_candidate,
};

const PUBLIC_LICENSE: &[u8] = include_bytes!("../../../LICENSE");
const SOURCE_DIGEST: &str =
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOOLCHAIN_DIGEST: &str =
    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn native_release_candidate_is_digest_bound_and_rolls_back_atomically() {
    let root = temp_root();
    let binary = root.join("revia");
    let candidate_one = root.join("candidate-one");
    let candidate_two = root.join("candidate-two");
    let install = root.join("install");
    fs::create_dir_all(&root).unwrap();
    fs::write(&binary, b"native-release-v1").unwrap();

    let first = build_release_candidate(
        &binary,
        &candidate_one,
        "darwin-arm64",
        SOURCE_DIGEST,
        TOOLCHAIN_DIGEST,
    )
    .unwrap();
    assert!(first.contains("re.native-release-candidate@0.1.0"));
    assert!(first.contains("\"release_version\":\"1.0.0-rc.2.2.1\""));
    assert!(!first.contains(root.to_str().unwrap()));
    assert_eq!(
        fs::read(candidate_one.join("LICENSE")).unwrap(),
        PUBLIC_LICENSE,
    );
    assert_eq!(
        verify_release_candidate(
            &candidate_one,
            "darwin-arm64",
            SOURCE_DIGEST,
            TOOLCHAIN_DIGEST
        )
        .unwrap(),
        first
    );

    install_release_candidate(
        &candidate_one,
        &install,
        "darwin-arm64",
        SOURCE_DIGEST,
        TOOLCHAIN_DIGEST,
    )
    .unwrap();
    fs::write(&binary, b"native-release-v2").unwrap();
    build_release_candidate(
        &binary,
        &candidate_two,
        "darwin-arm64",
        SOURCE_DIGEST,
        TOOLCHAIN_DIGEST,
    )
    .unwrap();
    install_release_candidate(
        &candidate_two,
        &install,
        "darwin-arm64",
        SOURCE_DIGEST,
        TOOLCHAIN_DIGEST,
    )
    .unwrap();
    let current_two = fs::read_to_string(install.join("current")).unwrap();
    rollback_release(&install, "darwin-arm64", SOURCE_DIGEST, TOOLCHAIN_DIGEST).unwrap();
    assert_ne!(
        fs::read_to_string(install.join("current")).unwrap(),
        current_two
    );

    let previous = fs::read_to_string(install.join("previous")).unwrap();
    let previous_candidate = install.join("versions").join(previous.trim());
    fs::write(previous_candidate.join("revia"), b"tampered").unwrap();
    assert_eq!(
        rollback_release(&install, "darwin-arm64", SOURCE_DIGEST, TOOLCHAIN_DIGEST).unwrap_err(),
        ReleaseError::new("native-release-previous-invalid")
    );

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn native_release_matrix_marks_only_measured_target() {
    let matrix = serialize_platform_matrix("darwin-arm64").unwrap();
    assert!(matrix.contains("\"status\":\"measured\""));
    assert!(matrix.contains("\"status\":\"pending\""));
    assert!(matrix.contains("windows-x64"));
}

#[test]
fn native_release_rejects_file_set_and_authority_drift_before_install() {
    let root = temp_root();
    let binary = root.join("revia");
    let candidate = root.join("candidate");
    let install = root.join("install");
    fs::create_dir_all(&root).unwrap();
    fs::write(&binary, b"native-release-authority").unwrap();
    build_release_candidate(
        &binary,
        &candidate,
        "darwin-arm64",
        SOURCE_DIGEST,
        TOOLCHAIN_DIGEST,
    )
    .unwrap();
    install_release_candidate(
        &candidate,
        &install,
        "darwin-arm64",
        SOURCE_DIGEST,
        TOOLCHAIN_DIGEST,
    )
    .unwrap();
    let current_before = fs::read_to_string(install.join("current")).unwrap();

    fs::write(candidate.join("unexpected.txt"), b"unexpected").unwrap();
    assert_eq!(
        verify_release_candidate(&candidate, "darwin-arm64", SOURCE_DIGEST, TOOLCHAIN_DIGEST)
            .unwrap_err(),
        ReleaseError::new("native-release-file-set-invalid")
    );
    assert_eq!(
        install_release_candidate(
            &candidate,
            &install,
            "darwin-arm64",
            SOURCE_DIGEST,
            TOOLCHAIN_DIGEST,
        )
        .unwrap_err(),
        ReleaseError::new("native-release-file-set-invalid")
    );
    assert_eq!(
        fs::read_to_string(install.join("current")).unwrap(),
        current_before
    );

    fs::remove_file(candidate.join("unexpected.txt")).unwrap();
    assert_eq!(
        verify_release_candidate(
            &candidate,
            "darwin-arm64",
            "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            TOOLCHAIN_DIGEST,
        )
        .unwrap_err(),
        ReleaseError::new("native-release-authority-mismatch")
    );

    fs::remove_dir_all(root).unwrap();
}

fn temp_root() -> PathBuf {
    std::env::temp_dir().join(format!(
        "revia-wp263-release-{}-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}
