use std::{
    fs,
    path::PathBuf,
    process::{Command, Output},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn temp_root() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("revia-wp486-{nanos}-{unique}"))
}

fn run(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(args)
        .output()
        .unwrap()
}

fn legend_codes(help: &str) -> Vec<u32> {
    help.lines()
        .map(str::trim_start)
        .filter_map(|line| {
            let mut parts = line.splitn(2, ' ');
            let number = parts.next()?;
            let rest = parts.next()?.trim();
            if rest.is_empty() {
                return None;
            }
            number.parse::<u32>().ok()
        })
        .collect()
}

#[test]
fn native_help_legend_explains_every_exit_code_the_cli_returns() {
    let root = temp_root();
    fs::create_dir_all(&root).unwrap();

    let help = run(&["--help"]);
    assert_eq!(help.status.code(), Some(0));
    let help_text = String::from_utf8_lossy(&help.stdout).into_owned();
    let legend = legend_codes(&help_text);
    assert!(legend.contains(&0), "the legend lost the success code");

    // Provoke each documented failure class and collect the code it produces.
    let usage = run(&["definitely-not-a-command"]);
    assert_eq!(usage.status.code(), Some(64));

    let contract = run(&["release-matrix", "not-a-target", "unused.json"]);
    assert_eq!(contract.status.code(), Some(65));

    let unreadable = run(&["check", "absent.re"]);
    assert_eq!(unreadable.status.code(), Some(66));

    let blocked = root.join("blocked");
    fs::create_dir(&blocked).unwrap();
    let write_failure = run(&["release-matrix", "darwin-arm64", blocked.to_str().unwrap()]);
    assert_eq!(write_failure.status.code(), Some(74));

    for code in [64_u32, 65, 66, 74] {
        assert!(
            legend.contains(&code),
            "the help legend does not explain exit code {code}: {help_text}"
        );
    }
    // The panic code cannot be provoked without crashing the suite, so only
    // its presence is checked: a legend entry means a reader can interpret it.
    assert!(
        legend.contains(&101),
        "the help legend does not explain exit code 101: {help_text}"
    );

    fs::remove_dir_all(&root).unwrap();
}
