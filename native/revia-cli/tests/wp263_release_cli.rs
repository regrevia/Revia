use std::{
    fs,
    path::PathBuf,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

const SOURCE_DIGEST: &str =
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOOLCHAIN_DIGEST: &str =
    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

#[test]
fn native_release_cli_packages_verifies_installs_and_rolls_back() {
    let root = temp_root();
    let binary = root.join("revia");
    let first = root.join("candidate-one");
    let second = root.join("candidate-two");
    let install = root.join("install");
    fs::create_dir_all(&root).unwrap();
    fs::write(&binary, b"cli-release-one").unwrap();

    let package = run([
        "release-package",
        binary.to_str().unwrap(),
        first.to_str().unwrap(),
        "darwin-arm64",
        SOURCE_DIGEST,
        TOOLCHAIN_DIGEST,
    ]);
    assert!(
        package.status.success(),
        "{}",
        String::from_utf8_lossy(&package.stderr)
    );
    assert!(String::from_utf8_lossy(&package.stdout).contains("re.native-release-candidate@0.1.0"));
    assert!(!String::from_utf8_lossy(&package.stdout).contains(root.to_str().unwrap()));

    let verify = run([
        "release-verify",
        first.to_str().unwrap(),
        "darwin-arm64",
        SOURCE_DIGEST,
        TOOLCHAIN_DIGEST,
    ]);
    assert_eq!(verify.stdout, package.stdout);

    let install_one = run([
        "release-install",
        first.to_str().unwrap(),
        install.to_str().unwrap(),
        "darwin-arm64",
        SOURCE_DIGEST,
        TOOLCHAIN_DIGEST,
    ]);
    assert!(install_one.status.success());
    let current_one = fs::read_to_string(install.join("current")).unwrap();

    fs::write(&binary, b"cli-release-two").unwrap();
    let package_two = run([
        "release-package",
        binary.to_str().unwrap(),
        second.to_str().unwrap(),
        "darwin-arm64",
        SOURCE_DIGEST,
        TOOLCHAIN_DIGEST,
    ]);
    assert!(package_two.status.success());
    let install_two = run([
        "release-install",
        second.to_str().unwrap(),
        install.to_str().unwrap(),
        "darwin-arm64",
        SOURCE_DIGEST,
        TOOLCHAIN_DIGEST,
    ]);
    assert!(install_two.status.success());
    assert_ne!(
        fs::read_to_string(install.join("current")).unwrap(),
        current_one
    );

    let rollback = run([
        "release-rollback",
        install.to_str().unwrap(),
        "darwin-arm64",
        SOURCE_DIGEST,
        TOOLCHAIN_DIGEST,
    ]);
    assert!(rollback.status.success());
    assert_eq!(
        fs::read_to_string(install.join("current")).unwrap(),
        current_one
    );

    let matrix_path = root.join("matrix.json");
    let matrix = run([
        "release-matrix",
        "darwin-arm64",
        matrix_path.to_str().unwrap(),
    ]);
    assert!(matrix.status.success());
    assert_eq!(matrix.stdout, fs::read(&matrix_path).unwrap());
    assert!(String::from_utf8_lossy(&matrix.stdout).contains("windows-x64"));
    assert!(String::from_utf8_lossy(&matrix.stdout).contains("\"pending\""));

    fs::remove_dir_all(root).unwrap();
}

fn run<const N: usize>(arguments: [&str; N]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(arguments)
        .output()
        .unwrap()
}

fn temp_root() -> PathBuf {
    std::env::temp_dir().join(format!(
        "revia-wp263-cli-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}
