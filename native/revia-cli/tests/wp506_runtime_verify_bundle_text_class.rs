use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// A bundle whose bytes are not UTF-8 was read successfully, so the refusal
/// must be a content rejection (exit 65). Only a file that cannot be opened
/// is an unreadable input (exit 66). Both halves are asserted together, so
/// collapsing the two classes fails whichever way it is collapsed.
#[test]
fn a_bundle_that_is_not_utf8_is_rejected_as_content_not_as_unreadable() {
    let root = temp_root("bundle-text-class");
    let source = root.join("hello.re");
    let bundle = root.join("runtime.rebundle");
    fs::create_dir_all(&root).unwrap();
    fs::write(&source, include_str!("../../../examples/hello.re")).unwrap();

    let packaged = run(&[
        "runtime-package",
        source.to_str().unwrap(),
        bundle.to_str().unwrap(),
    ]);
    assert!(packaged.status.success(), "{}", text(&packaged.stderr));

    let original = fs::read(&bundle).unwrap();
    assert_eq!(original[0], b'{');
    let mut corrupted = original.clone();
    corrupted[0] = 0xff;
    fs::write(&bundle, &corrupted).unwrap();

    let rejected = run(&["runtime-verify", bundle.to_str().unwrap()]);
    assert_eq!(rejected.status.code(), Some(65));
    assert!(rejected.stdout.is_empty());
    assert_eq!(
        text(&rejected.stderr),
        "{\"diagnostics\":[{\"code\":\"native-runtime-bundle-json-invalid\"}],\
         \"ok\":false,\"schema\":\"re.native-runtime-bundle@0.1.0\"}\n"
    );

    let missing = root.join("absent.rebundle");
    let unreadable = run(&["runtime-verify", missing.to_str().unwrap()]);
    assert_eq!(unreadable.status.code(), Some(66));
    assert!(unreadable.stdout.is_empty());
    assert_eq!(
        text(&unreadable.stderr),
        "{\"diagnostics\":[{\"code\":\"native-runtime-bundle-unreadable\"}],\
         \"ok\":false,\"schema\":\"re.native-runtime-bundle@0.1.0\"}\n"
    );

    let directory = run(&["runtime-verify", root.to_str().unwrap()]);
    assert_eq!(directory.status.code(), Some(66));
    assert!(directory.stdout.is_empty());
    assert_eq!(
        text(&directory.stderr),
        "{\"diagnostics\":[{\"code\":\"native-runtime-bundle-unreadable\"}],\
         \"ok\":false,\"schema\":\"re.native-runtime-bundle@0.1.0\"}\n"
    );

    fs::write(&bundle, &original).unwrap();
    let verified = run(&["runtime-verify", bundle.to_str().unwrap()]);
    assert_eq!(
        verified.status.code(),
        Some(0),
        "{}",
        text(&verified.stderr)
    );
    assert!(text(&verified.stdout).contains("\"ok\":true"));
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

fn temp_root(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "revia-wp506-{label}-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ))
}
