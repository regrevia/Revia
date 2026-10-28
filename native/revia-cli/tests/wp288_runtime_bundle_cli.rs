use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

use revia_core::{
    canonical_json::{JsonValue, canonicalize},
    digest::sha256_hex,
    runtime_bundle::parse_runtime_bundle,
};

const INPUT_DIGEST: &str =
    "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn runtime_bundle_packages_replays_and_moves_without_node() {
    let root = temp_root("success");
    let source = root.join("hello.re");
    let bundle = root.join("first/runtime.rebundle");
    let second_bundle = root.join("second/runtime.rebundle");
    fs::create_dir_all(root.join("first")).unwrap();
    fs::create_dir_all(root.join("second")).unwrap();
    fs::write(&source, include_str!("../../../examples/hello.re")).unwrap();

    let first = run(&[
        "runtime-package",
        source.to_str().unwrap(),
        bundle.to_str().unwrap(),
    ]);
    assert!(first.status.success(), "{}", text(&first.stderr));
    assert_eq!(first.stdout, fs::read(&bundle).unwrap());

    let second = run(&[
        "runtime-package",
        source.to_str().unwrap(),
        second_bundle.to_str().unwrap(),
    ]);
    assert!(second.status.success(), "{}", text(&second.stderr));
    assert_eq!(first.stdout, second.stdout);

    let staged = run(&["execute", source.to_str().unwrap(), INPUT_DIGEST]);
    let replayed = run(&[
        "runtime-run",
        bundle.to_str().unwrap(),
        INPUT_DIGEST,
        root.to_str().unwrap(),
    ]);
    assert!(staged.status.success(), "{}", text(&staged.stderr));
    assert!(replayed.status.success(), "{}", text(&replayed.stderr));
    assert_eq!(replayed.stdout, staged.stdout);
    assert!(replayed.stderr.is_empty());
    assert!(!text(&replayed.stdout).contains(root.to_str().unwrap()));

    fs::create_dir_all(root.join("moved")).unwrap();
    let moved = root.join("moved/runtime.rebundle");
    fs::copy(&bundle, &moved).unwrap();
    let moved_run = run(&[
        "runtime-run",
        moved.to_str().unwrap(),
        INPUT_DIGEST,
        root.to_str().unwrap(),
    ]);
    assert!(moved_run.status.success(), "{}", text(&moved_run.stderr));
    assert_eq!(moved_run.stdout, staged.stdout);

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn runtime_bundle_rejects_tampering_before_effect_and_partial_write() {
    let root = temp_root("reject");
    let source = root.join("hello.re");
    let bundle = root.join("runtime.rebundle");
    fs::create_dir_all(&root).unwrap();
    fs::write(&source, include_str!("../../../examples/hello.re")).unwrap();
    let packaged = run(&[
        "runtime-package",
        source.to_str().unwrap(),
        bundle.to_str().unwrap(),
    ]);
    assert!(packaged.status.success());

    let mut bytes = fs::read(&bundle).unwrap();
    bytes.reverse();
    fs::write(&bundle, bytes).unwrap();
    let rejected = run(&[
        "runtime-run",
        bundle.to_str().unwrap(),
        INPUT_DIGEST,
        root.to_str().unwrap(),
    ]);
    assert_eq!(rejected.status.code(), Some(65));
    assert!(rejected.stdout.is_empty());
    assert!(text(&rejected.stderr).contains("native-runtime-bundle"));

    let output_directory = root.join("occupied");
    fs::create_dir(&output_directory).unwrap();
    let failed = run(&[
        "runtime-package",
        source.to_str().unwrap(),
        output_directory.to_str().unwrap(),
    ]);
    assert_eq!(failed.status.code(), Some(74));
    assert!(output_directory.is_dir());
    assert_eq!(
        fs::read_dir(&root)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().starts_with("occupied."))
            .count(),
        0
    );

    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn runtime_bundle_rejects_symlink_and_non_directory_sandbox() {
    use std::os::unix::fs::symlink;

    let root = temp_root("sandbox");
    let source = root.join("hello.re");
    let bundle = root.join("runtime.rebundle");
    let real_sandbox = root.join("real");
    let linked_sandbox = root.join("linked");
    let file_sandbox = root.join("sandbox.txt");
    fs::create_dir_all(&real_sandbox).unwrap();
    fs::write(&source, include_str!("../../../examples/hello.re")).unwrap();
    fs::write(&file_sandbox, b"not a directory").unwrap();
    symlink(&real_sandbox, &linked_sandbox).unwrap();

    let packaged = run(&[
        "runtime-package",
        source.to_str().unwrap(),
        bundle.to_str().unwrap(),
    ]);
    assert!(packaged.status.success(), "{}", text(&packaged.stderr));

    for sandbox in [&linked_sandbox, &file_sandbox] {
        let rejected = run(&[
            "runtime-run",
            bundle.to_str().unwrap(),
            INPUT_DIGEST,
            sandbox.to_str().unwrap(),
        ]);
        assert_eq!(rejected.status.code(), Some(65));
        assert!(rejected.stdout.is_empty());
        assert!(text(&rejected.stderr).contains("native-runtime-bundle-sandbox-invalid"));
    }

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn runtime_bundle_rejects_invalid_input_before_host_effect() {
    let root = temp_root("input");
    let source = root.join("write.re");
    let bundle = root.join("runtime.rebundle");
    let sandbox = root.join("sandbox");
    let target = sandbox.join("output.txt");
    fs::create_dir_all(&sandbox).unwrap();
    fs::write(&source, include_str!("../../../examples/write-check.re")).unwrap();

    let packaged = run(&[
        "runtime-package",
        source.to_str().unwrap(),
        bundle.to_str().unwrap(),
    ]);
    assert!(packaged.status.success(), "{}", text(&packaged.stderr));

    let rejected = run(&[
        "runtime-run",
        bundle.to_str().unwrap(),
        "not-a-digest",
        sandbox.to_str().unwrap(),
    ]);
    assert_eq!(rejected.status.code(), Some(65));
    assert!(rejected.stdout.is_empty());
    assert!(text(&rejected.stderr).contains("native-vm-request-input-digest-invalid"));
    assert!(!target.exists());

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn runtime_bundle_rejects_synchronized_payload_resign() {
    let root = temp_root("resign");
    let source = root.join("hello.re");
    let bundle = root.join("runtime.rebundle");
    let sandbox = root.join("sandbox");
    fs::create_dir_all(&sandbox).unwrap();
    fs::write(&source, include_str!("../../../examples/hello.re")).unwrap();
    let packaged = run(&[
        "runtime-package",
        source.to_str().unwrap(),
        bundle.to_str().unwrap(),
    ]);
    assert!(packaged.status.success());

    let original = String::from_utf8(fs::read(&bundle).unwrap()).unwrap();
    let mut tampered = parse_runtime_bundle(&original).unwrap();
    tampered.canonical_source = tampered
        .canonical_source
        .replace("unit @hello\n", "unit @tampered\n");
    tampered.source_digest = digest(tampered.canonical_source.as_bytes());
    tampered.bundle_digest =
        digest(canonicalize(&bundle_json_without_digest(&tampered)).as_bytes());
    let value = format!("{}\n", canonicalize(&bundle_json(&tampered)));
    fs::write(&bundle, value).unwrap();
    let rejected = run(&[
        "runtime-run",
        bundle.to_str().unwrap(),
        INPUT_DIGEST,
        sandbox.to_str().unwrap(),
    ]);
    assert_eq!(rejected.status.code(), Some(65));
    assert!(rejected.stdout.is_empty());
    assert!(text(&rejected.stderr).contains("native-runtime-bundle"));

    fs::remove_dir_all(root).unwrap();
}

fn run(arguments: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(arguments)
        .env_clear()
        .env("PATH", "")
        .output()
        .unwrap()
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8(bytes.to_vec()).unwrap()
}

fn digest(bytes: &[u8]) -> String {
    format!("sha256:{}", sha256_hex(bytes))
}

fn bundle_json_without_digest(
    bundle: &revia_core::runtime_bundle::NativeRuntimeBundle,
) -> JsonValue {
    JsonValue::Object(vec![
        (
            "artifact".to_owned(),
            JsonValue::String(bundle.artifact.clone()),
        ),
        (
            "artifact_digest".to_owned(),
            JsonValue::String(bundle.artifact_digest.clone()),
        ),
        (
            "canonical_source".to_owned(),
            JsonValue::String(bundle.canonical_source.clone()),
        ),
        (
            "graph_revision".to_owned(),
            JsonValue::String(bundle.graph_revision.clone()),
        ),
        (
            "profile".to_owned(),
            JsonValue::String(bundle.profile.clone()),
        ),
        (
            "release".to_owned(),
            JsonValue::String(bundle.release.clone()),
        ),
        (
            "schema".to_owned(),
            JsonValue::String(bundle.schema.clone()),
        ),
        (
            "source_digest".to_owned(),
            JsonValue::String(bundle.source_digest.clone()),
        ),
        (
            "translator".to_owned(),
            JsonValue::String(bundle.translator.clone()),
        ),
    ])
}

fn bundle_json(bundle: &revia_core::runtime_bundle::NativeRuntimeBundle) -> JsonValue {
    let mut fields = match bundle_json_without_digest(bundle) {
        JsonValue::Object(fields) => fields,
        _ => unreachable!(),
    };
    fields.push((
        "bundle_digest".to_owned(),
        JsonValue::String(bundle.bundle_digest.clone()),
    ));
    JsonValue::Object(fields)
}

fn temp_root(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "revia-wp288-{label}-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ))
}
