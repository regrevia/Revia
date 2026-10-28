use std::{
    fs,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

use revia_core::project::load_project_directory;

#[test]
fn conformance_generates_a_native_node_free_enterprise_fixture() {
    let root = std::env::temp_dir().join(format!(
        "revia-wp262-fixture-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let output = Command::new(env!("CARGO_BIN_EXE_revia-conformance"))
        .args(["node-free-fixture", root.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let project = load_project_directory(&root).unwrap();
    assert_eq!(project.modules.len(), 50);
    assert_eq!(project.package_manifest.modules.len(), 50);
    assert_eq!(
        project.package_manifest.modules[0].interface.exports.len(),
        2
    );
    assert!(root.join("modules/m000.re").is_file());
    assert!(root.join("project.json").is_file());
    fs::remove_dir_all(&root).unwrap();
}
