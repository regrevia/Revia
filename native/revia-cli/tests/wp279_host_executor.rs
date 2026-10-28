use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use revia_core::{
    digest::sha256_hex,
    project::{
        NativeExport, NativeInterface, NativeModule, NativePackage, NativeProjectModule,
        serialize_project_manifest,
    },
    project_runtime::{NativeProjectExecutionPlan, serialize_project_execution_plan},
};

const PROFILE: &str = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const TOOLCHAIN: &str = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const INPUT: &str = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const SOURCE: &str = include_str!("../../../examples/write-check.re");
const CONTRACT: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
static TEMP_NONCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn native_project_run_uses_the_real_host_for_filesystem_effects() {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let root = temp_root();
    let cache = root.with_file_name("revia-wp279-host-cache");
    let build = root.with_file_name("revia-wp279-host-build");
    fs::create_dir_all(root.join("modules")).unwrap();
    let source_digest = format!("sha256:{}", sha256_hex(SOURCE.as_bytes()));
    fs::write(root.join("modules/write.re"), SOURCE).unwrap();
    let package = NativePackage::new(
        "agent.host",
        vec![NativeModule::new(
            "agent.host.write",
            source_digest.clone(),
            NativeInterface::new(
                "agent.host.write",
                vec![],
                vec![NativeExport::function("main", CONTRACT)],
            ),
        )],
    );
    fs::write(
        root.join("project.json"),
        serialize_project_manifest(
            &[NativeProjectModule::new(
                "agent.host.write",
                "modules/write.re",
                source_digest,
            )],
            &package,
        )
        .unwrap(),
    )
    .unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_revia"))
        .current_dir(&repo_root)
        .args([
            "project-run",
            root.to_str().unwrap(),
            cache.to_str().unwrap(),
            build.to_str().unwrap(),
            PROFILE,
            TOOLCHAIN,
            "agent.host.write",
            INPUT,
        ])
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        fs::read(root.join("output.txt")).unwrap(),
        b"A\0B",
        "project-run must perform the declared fs.write effect"
    );

    fs::remove_dir_all(&root).unwrap();
    let _ = fs::remove_dir_all(cache);
    let _ = fs::remove_dir_all(build);
}

#[test]
fn native_project_entry_variants_share_real_host_effects() {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let root = temp_root();
    let cache = root.with_file_name("revia-wp279-variants-cache");
    let build = root.with_file_name("revia-wp279-variants-build");
    fs::create_dir_all(root.join("modules")).unwrap();
    let source_digest = format!("sha256:{}", sha256_hex(SOURCE.as_bytes()));
    fs::write(root.join("modules/write.re"), SOURCE).unwrap();
    let package = NativePackage::new(
        "agent.host",
        vec![NativeModule::new(
            "agent.host.write",
            source_digest.clone(),
            NativeInterface::new(
                "agent.host.write",
                vec![],
                vec![NativeExport::function("main", CONTRACT)],
            ),
        )],
    );
    fs::write(
        root.join("project.json"),
        serialize_project_manifest(
            &[NativeProjectModule::new(
                "agent.host.write",
                "modules/write.re",
                source_digest,
            )],
            &package,
        )
        .unwrap(),
    )
    .unwrap();
    let plan_path = root.with_file_name("revia-wp279-variants-plan.json");
    let plan = NativeProjectExecutionPlan::new("agent.host.write", "main", Vec::new());
    fs::write(&plan_path, serialize_project_execution_plan(&plan).unwrap()).unwrap();

    for arguments in [
        vec![
            "project-execute".to_owned(),
            root.to_str().unwrap().to_owned(),
            "agent.host.write".to_owned(),
            PROFILE.to_owned(),
            TOOLCHAIN.to_owned(),
            INPUT.to_owned(),
        ],
        vec![
            "project-execute-plan".to_owned(),
            root.to_str().unwrap().to_owned(),
            plan_path.to_str().unwrap().to_owned(),
            PROFILE.to_owned(),
            TOOLCHAIN.to_owned(),
            INPUT.to_owned(),
        ],
        vec![
            "project-execute-plan-direct".to_owned(),
            root.to_str().unwrap().to_owned(),
            plan_path.to_str().unwrap().to_owned(),
            PROFILE.to_owned(),
            TOOLCHAIN.to_owned(),
            INPUT.to_owned(),
        ],
        vec![
            "project-execute-plan-cached".to_owned(),
            root.to_str().unwrap().to_owned(),
            plan_path.to_str().unwrap().to_owned(),
            root.with_file_name("revia-wp279-variants-execution-cache.json")
                .to_str()
                .unwrap()
                .to_owned(),
            PROFILE.to_owned(),
            TOOLCHAIN.to_owned(),
            INPUT.to_owned(),
        ],
        vec![
            "project-server-smoke".to_owned(),
            root.to_str().unwrap().to_owned(),
            "agent.host.write".to_owned(),
            PROFILE.to_owned(),
            TOOLCHAIN.to_owned(),
            INPUT.to_owned(),
        ],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_revia"))
            .current_dir(&repo_root)
            .args(arguments)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(fs::read(root.join("output.txt")).unwrap(), b"A\0B");
        fs::remove_file(root.join("output.txt")).unwrap();
    }

    let execution_cache = root.with_file_name("revia-wp279-variants-execution-cache.json");
    fs::remove_dir_all(&root).unwrap();
    let _ = fs::remove_file(plan_path);
    let _ = fs::remove_dir_all(cache);
    let _ = fs::remove_dir_all(build);
    let _ = fs::remove_file(execution_cache);
}

fn temp_root() -> PathBuf {
    std::env::temp_dir().join(format!(
        "revia-wp279-host-{}-{}-{}",
        std::process::id(),
        TEMP_NONCE.fetch_add(1, Ordering::Relaxed),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}
