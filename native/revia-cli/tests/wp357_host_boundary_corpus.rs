//! WP-357: the measured host boundary around one guest program.
//!
//! WP-356 pinned the declared-capability surface. This file pins the surface
//! *underneath* it: every host operation a program can reach today (the four
//! builtin members plus the process status domain and the three served declared
//! members), each with a fail-closed negative and — where the boundary admits
//! one — a granted case next to it.
//!
//! Two facts from the probes shape the corpus and are worth stating here,
//! because a reader would otherwise expect the opposite:
//!
//! - The capability policy does **not** gate the builtin surface. A program
//!   using `fs.read` runs with no policy at all, and runs with a policy whose
//!   grant list is empty. A policy that *names* a builtin is refused as
//!   `native-host-capability-policy-not-served`, so the policy can neither
//!   widen nor narrow that surface. The boundary that actually holds is the
//!   host configuration: the sandbox root is the source file's parent
//!   directory, arguments/environment/secrets are empty, and there are 1 MiB
//!   byte budgets.
//! - A refused filesystem path is not a host fault. `validate_path` and the
//!   lexical/canonical prefix checks fold into a program-visible `err`, so the
//!   guest exits through its own err branch (2 here) while the CLI still exits
//!   0 with `"ok":true`. Asserting `native-vm-capability-failed` or exit 65 for
//!   those cases would pin the wrong behaviour.
//!
//! Both diagnostic channels are asserted, and a case states which stream must
//! stay empty. The corpus is plain JSON so a second implementation can replay
//! it; `expand` is the one driver directive: it replaces a placeholder in a
//! program with a repeated character, because a 1 MiB literal would otherwise
//! have to be spelled out in the fixture.

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use revia_core::canonical_json::{JsonValue, canonicalize};
use revia_core::project::parse_json;

const CORPUS: &str = include_str!("../../../test/fixtures/host-boundary-refusal-corpus.json");
const CORPUS_SCHEMA: &str = "re.host-boundary-refusal-corpus@0.1.0";
const GRAPH_RESULT: &str = "re.native-graph-result@0.1.0";
const HOST_RESULT: &str = "re.native-host-execution-result@0.1.0";

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// A path outside the sandbox that the absolute-path cases name. The real path
/// is substituted per case so concurrent runs never share a fixed `/tmp` file
/// and a stale file from a failed run cannot poison the next one.
const ABSOLUTE_TARGET_PLACEHOLDER: &str = "__ABSOLUTE_TARGET__";

fn field<'a>(value: &'a JsonValue, name: &str) -> &'a JsonValue {
    let JsonValue::Object(fields) = value else {
        panic!("a corpus node must be an object, not {value:?}");
    };
    fields
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value)
        .unwrap_or_else(|| panic!("a corpus node must carry `{name}`: {value:?}"))
}

fn optional<'a>(value: &'a JsonValue, name: &str) -> Option<&'a JsonValue> {
    let JsonValue::Object(fields) = value else {
        panic!("a corpus node must be an object, not {value:?}");
    };
    match fields.iter().find(|(key, _)| key == name) {
        None | Some((_, JsonValue::Null)) => None,
        Some((_, other)) => Some(other),
    }
}

fn string(value: &JsonValue) -> &str {
    let JsonValue::String(text) = value else {
        panic!("expected a string, found {value:?}");
    };
    text
}

fn entries(value: &JsonValue) -> &[JsonValue] {
    let JsonValue::Array(items) = value else {
        panic!("expected an array, found {value:?}");
    };
    items
}

fn temp_root() -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "revia-wp357-{}-{stamp}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::SeqCst)
    ))
}

/// A per-case temporary directory removed on drop, including when an assertion
/// panics part way through the case.
struct TempRoot(PathBuf);

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Expands `expand` directives in a program text.
fn expand_program(case: &JsonValue, program: &str) -> String {
    let mut text = program.to_owned();
    if let Some(directives) = optional(case, "expand") {
        for directive in entries(directives) {
            let placeholder = string(field(directive, "placeholder"));
            let character = string(field(directive, "char"));
            let JsonValue::Number(count) = field(directive, "count") else {
                panic!("expand.count must be a number");
            };
            let count: usize = count.parse().unwrap();
            text = text.replace(placeholder, &character.repeat(count));
        }
    }
    text
}

/// Materializes one `prepare` entry: a regular file, possibly filled.
fn prepare(entry: &JsonValue, sandbox: &Path, parent: &Path) {
    let base = match string(field(entry, "where")) {
        "sandbox" => sandbox,
        "parent" => parent,
        other => panic!("prepare.where must be sandbox or parent, found {other}"),
    };
    let path = base.join(string(field(entry, "path")));
    match string(field(entry, "kind")) {
        "file" => {
            let bytes = match optional(entry, "content") {
                Some(content) => string(content).to_owned(),
                None => {
                    let JsonValue::Object(_) = field(entry, "fill") else {
                        panic!("a file entry needs content or fill");
                    };
                    let fill = field(entry, "fill");
                    let character = string(field(fill, "char"));
                    let JsonValue::Number(count) = field(fill, "count") else {
                        panic!("fill.count must be a number");
                    };
                    let count: usize = count.parse().unwrap();
                    character.repeat(count)
                }
            };
            if let Some(directory) = path.parent() {
                fs::create_dir_all(directory).unwrap();
            }
            fs::write(&path, bytes).unwrap();
        }
        other => panic!("unsupported prepare kind {other}"),
    }
}

/// Checks one `after` entry: a path exists (optionally with content) or does not.
fn check_after(entry: &JsonValue, sandbox: &Path, parent: &Path) {
    let base = match string(field(entry, "where")) {
        "sandbox" => Some(sandbox),
        "parent" => Some(parent),
        "absolute" => None,
        other => panic!("after.where must be sandbox, parent or absolute, found {other}"),
    };
    let path = match base {
        Some(base) => base.join(string(field(entry, "path"))),
        None => PathBuf::from(string(field(entry, "path"))),
    };
    let JsonValue::Bool(exists) = field(entry, "exists") else {
        panic!("after.exists must be a bool");
    };
    if !*exists {
        assert!(!path.exists(), "{} must not exist", path.display());
        return;
    }
    let Some(content) = optional(entry, "content").map(string) else {
        assert!(path.exists(), "{} must exist", path.display());
        return;
    };
    assert_eq!(
        fs::read_to_string(&path).unwrap_or_else(|error| panic!(
            "{} must exist and be readable: {error}",
            path.display()
        )),
        content,
        "{} content",
        path.display()
    );
}

/// Runs one corpus case with the real binary and returns (exit, stdout, stderr).
fn run_case(case: &JsonValue, input_digest: &str, root: &Path) -> (Option<i32>, String, String) {
    let sandbox = root.join("sandbox");
    fs::create_dir_all(&sandbox).unwrap();
    let source_path = sandbox.join("program.re");
    let registry_path = root.join("registry.json");
    let policy_path = root.join("policy.json");
    let artifact_path = root.join("artifact.rebc");

    for entry in entries(field(case, "prepare")) {
        prepare(entry, &sandbox, root);
    }
    // The guest sees this literal in program text, so the path is emitted with
    // forward slashes: a Windows backslash would otherwise be read as a string
    // escape. Windows accepts forward slashes in absolute paths.
    let absolute_target = root
        .join("absolute-target.txt")
        .to_str()
        .expect("the temporary root is utf-8")
        .replace('\\', "/");
    let program = expand_program(case, string(field(case, "program")))
        .replace(ABSOLUTE_TARGET_PLACEHOLDER, &absolute_target);
    fs::write(&source_path, program).unwrap();
    if let Some(registry) = optional(case, "registry") {
        fs::write(&registry_path, canonicalize(registry)).unwrap();
    }
    let policy = optional(case, "policy").map(|policy| {
        let artifact = match policy {
            JsonValue::String(raw) => raw.clone(),
            other => canonicalize(other),
        };
        fs::write(&policy_path, artifact).unwrap();
        policy_path.to_str().unwrap().to_owned()
    });

    let mode = string(field(case, "mode"));
    let registry_arguments = optional(case, "registry")
        .map(|_| {
            vec![
                "--schema-registry".to_owned(),
                registry_path.to_str().unwrap().to_owned(),
            ]
        })
        .unwrap_or_default();

    if mode == "run" {
        // The artifact is produced without a policy: `compile` has no policy
        // flag at all. Only the later `run` is authorized, which is what makes
        // the two run cases an artifact-widening measurement.
        let mut compile = Command::new(env!("CARGO_BIN_EXE_revia"));
        compile
            .arg("compile")
            .args(&registry_arguments)
            .arg(&source_path)
            .arg(&artifact_path);
        let compiled = compile.output().unwrap();
        assert_eq!(
            compiled.status.code(),
            Some(0),
            "artifact-run cases need a compiling program: {}",
            String::from_utf8_lossy(&compiled.stdout)
        );
    }

    let mut arguments: Vec<String> = vec![mode.to_owned()];
    arguments.extend(registry_arguments);
    if let Some(policy) = policy {
        arguments.push("--capability-policy".to_owned());
        arguments.push(policy);
    }
    arguments.push(source_path.to_str().unwrap().to_owned());
    if mode == "run" {
        arguments.push(artifact_path.to_str().unwrap().to_owned());
    }
    arguments.push(input_digest.to_owned());

    let output = Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(&arguments)
        .output()
        .unwrap();
    (
        output.status.code(),
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

#[test]
fn the_host_boundary_refusal_corpus_holds_its_cases() {
    let corpus = parse_json(CORPUS).unwrap();
    assert_eq!(string(field(&corpus, "schema")), CORPUS_SCHEMA);
    assert_eq!(string(field(&corpus, "version")), "0.1.0");
    let input_digest = string(field(&corpus, "input_digest"));

    let mut seen: Vec<String> = Vec::new();
    for case in entries(field(&corpus, "cases")) {
        let expected = field(case, "expected");
        let id = string(field(case, "id"));
        assert!(
            !seen.iter().any(|seen| seen.as_str() == id),
            "duplicate case id {id}"
        );
        let catches = string(field(case, "catches"));
        assert!(
            !catches.trim().is_empty(),
            "{id} must state what an implementation change would break"
        );
        assert!(
            matches!(string(field(case, "mode")), "execute" | "run"),
            "{id} names an unknown mode"
        );

        let JsonValue::Number(wanted_exit) = field(expected, "exit") else {
            panic!("{id} expected.exit must be a number");
        };
        let wanted_exit: i32 = wanted_exit.parse().unwrap();
        let channel = string(field(expected, "channel"));
        let silent = match field(expected, "silent") {
            JsonValue::Null => None,
            other => Some(string(other)),
        };
        let schema = string(field(expected, "schema"));
        let contains: Vec<&str> = entries(field(expected, "contains"))
            .iter()
            .map(string)
            .collect();

        // Both known result schemas are only ever produced on one stream, and a
        // case that names one must not be satisfiable by the other.
        assert!(
            schema.is_empty() || schema == GRAPH_RESULT || schema == HOST_RESULT,
            "{id} names an unknown result schema"
        );
        // A silent stream and the asserted stream are never the same one.
        if let Some(silent) = silent {
            assert!(
                silent != channel,
                "{id} cannot both assert and silence the {channel} channel"
            );
        }

        let root = TempRoot(temp_root());
        let (actual_exit, stdout, stderr) = run_case(case, input_digest, &root.0);

        for entry in entries(field(case, "after")) {
            check_after(entry, &root.0.join("sandbox"), &root.0);
        }

        assert_eq!(actual_exit, Some(wanted_exit), "{id}: exit status");
        let (produced, ignored) = match channel {
            "stdout" => (&stdout, &stderr),
            "stderr" => (&stderr, &stdout),
            other => panic!("{id} names an unknown channel {other}"),
        };
        if !schema.is_empty() {
            assert!(
                produced.contains(schema),
                "{id}: {channel} must carry the {schema} result, found `{produced}`"
            );
        }
        for fragment in &contains {
            assert!(
                produced.contains(fragment),
                "{id}: {channel} must contain `{fragment}`, found `{produced}`"
            );
        }
        if let Some(silent) = silent {
            let silent_channel = match silent {
                "stdout" => &stdout,
                "stderr" => &stderr,
                other => panic!("{id} names an unknown silent channel {other}"),
            };
            assert!(
                silent_channel.trim().is_empty(),
                "{id}: the {silent} channel must stay empty, found `{silent_channel}`"
            );
        }
        assert!(
            !ignored.contains("native-host-capability-policy-invalid"),
            "{id}: an invalid policy must not be reported on the channel this case does not assert"
        );
        seen.push(id.to_owned());
    }

    let wanted = [
        "builtin-read-granted",
        "builtin-read-missing-file",
        "builtin-read-relative-escape",
        "builtin-read-absolute-path",
        "builtin-read-size-limit",
        "builtin-write-granted",
        "builtin-write-relative-escape",
        "builtin-write-absolute-path",
        "builtin-stdout-granted",
        "builtin-stdout-over-limit",
        "builtin-args-empty",
        "policy-does-not-gate-builtins",
        "policy-naming-builtin-refused",
        "policy-naming-write-builtin-refused",
        "exit-status-domain-refused",
        "declared-clock-granted",
        "declared-clock-ungranted",
        "declared-unsupported-family-refused",
        "declared-family-without-registry-refused",
        "artifact-run-granted",
        "artifact-run-without-grant",
        "artifact-run-registry-not-grant",
    ];
    for id in wanted {
        assert!(
            seen.iter().any(|seen| seen.as_str() == id),
            "missing case {id}"
        );
    }
    assert_eq!(
        seen.len(),
        wanted.len(),
        "the corpus must hold exactly the cases this test knows"
    );
}

/// The symlink forms are Unix-only checks in the driver rather than corpus
/// cases: the fixture format has no portable way to say "create a symlink",
/// and on Windows that needs a privilege the CI runner does not hold.
#[cfg(unix)]
#[test]
fn a_symlink_inside_the_sandbox_cannot_reach_outside_it() {
    use std::os::unix::fs::symlink;

    let root = TempRoot(temp_root());
    let sandbox = root.0.join("sandbox");
    fs::create_dir_all(&sandbox).unwrap();
    fs::write(root.0.join("target.txt"), "orig\n").unwrap();
    symlink("../target.txt", sandbox.join("link.txt")).unwrap();

    let read = sandbox.join("read.re");
    fs::write(
        &read,
        "re 0.1 compact\n\nunit @agent_read\n\ncap @input: fs.read@0.1.0\n\n\
         fn @main() -> process.status {\n\
         \x20 %report = @input.read_file(path: \"link.txt\", encoding: text.encoding.utf8)\n\
         \x20 return match %report {\n\
         \x20   ok(_) => process.exit(0)\n\
         \x20   err(_) => process.exit(2)\n\
         \x20 }\n}\n",
    )
    .unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_revia"))
        .arg("execute")
        .arg(&read)
        .arg(format!("sha256:{}", "0".repeat(64)))
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert_eq!(output.status.code(), Some(0), "read symlink exit: {stdout}");
    assert!(
        stdout.contains("\"member\":\"read_file\",\"outcome\":\"err\""),
        "a symlink that leaves the sandbox root must be refused: {stdout}"
    );

    let write = sandbox.join("write.re");
    fs::write(
        &write,
        "re 0.1 compact\n\nunit @agent_write\n\ncap @out: fs.write@0.1.0\n\n\
         fn @main() -> process.status {\n\
         \x20 %report = @out.write_file(data: \"hex:68656c6c6f\", path: \"link.txt\")\n\
         \x20 return match %report {\n\
         \x20   ok(_) => process.exit(0)\n\
         \x20   err(_) => process.exit(2)\n\
         \x20 }\n}\n",
    )
    .unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_revia"))
        .arg("execute")
        .arg(&write)
        .arg(format!("sha256:{}", "0".repeat(64)))
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert_eq!(
        output.status.code(),
        Some(0),
        "write symlink exit: {stdout}"
    );
    assert!(
        stdout.contains("\"outcome\":{\"code\":2"),
        "writing through a symlink must be refused: {stdout}"
    );
    assert_eq!(
        fs::read_to_string(root.0.join("target.txt")).unwrap(),
        "orig\n",
        "the write target outside the sandbox must be untouched"
    );
}
