use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Component, Path, PathBuf},
    process,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    thread,
    time::Instant,
};

#[cfg(target_os = "windows")]
use std::ffi::c_void;
#[cfg(target_os = "windows")]
use std::io;

#[cfg(target_os = "windows")]
#[link(name = "bcrypt")]
unsafe extern "system" {
    fn BCryptGenRandom(algorithm: *mut c_void, buffer: *mut u8, length: u32, flags: u32) -> i32;
}

#[cfg(target_os = "windows")]
struct WindowsRandom;

#[cfg(target_os = "windows")]
impl Read for WindowsRandom {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        let status = unsafe {
            BCryptGenRandom(
                std::ptr::null_mut(),
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                0x00000002,
            )
        };
        if status == 0 {
            Ok(buffer.len())
        } else {
            Err(io::Error::other("BCryptGenRandom failed"))
        }
    }
}

use revia_core::{
    bytecode::{
        NATIVE_BYTECODE_PROFILE, load_bytecode_artifact, serialize_bytecode_artifact,
        translate_graph, verify_bytecode_artifact,
    },
    canonical_json::{JsonValue, canonicalize, quote},
    capability_comparison::{
        CapabilityComparisonObservation, CapabilitySandboxFile, build_capability_comparison_report,
        parse_capability_comparison_catalog, sandbox_digest as capability_sandbox_digest,
        serialize_capability_comparison_report,
    },
    capability_project_comparison::{
        CAPABILITY_PROJECT_COMPARISON_REPORT_SCHEMA, CapabilityProjectComparisonCatalog,
        CapabilityProjectComparisonObservation, CapabilityProjectComparisonWorkload,
        build_capability_project_comparison_report,
        catalog_digest as capability_project_catalog_digest,
        parse_capability_project_comparison_catalog, parse_capability_project_comparison_report,
        serialize_capability_project_comparison_catalog,
        serialize_capability_project_comparison_report,
    },
    comparison_catalog::{
        ComparisonObservation, build_comparison_report, comparison_semantic_digest,
        parse_comparison_catalog, parse_comparison_report, serialize_comparison_report,
    },
    cross_language::{
        CrossLanguageBackendResult, CrossLanguageInvocation, PendingBackend,
        build_cross_language_matrix, parse_backend_result, serialize_cross_language_matrix,
    },
    digest::sha256_hex,
    experiment_kit::{build_experiment_kit, serialize_experiment_kit},
    fault_corpus::{
        FaultEvidenceScope, FaultStage, NativeFaultCorpusCase, NativeFaultObservation,
        NativeFaultPendingBackend, NativeFaultReleaseRun,
        build_native_fault_corpus_release_evidence, build_native_fault_corpus_report,
        parse_native_fault_corpus, parse_native_fault_corpus_release_evidence,
        parse_native_fault_corpus_report, serialize_native_fault_corpus_release_evidence,
        serialize_native_fault_corpus_report,
    },
    graph::{
        check_graph, graph_revision, load_canonical_graph, parse_compact_graph, review_manifest,
        serialize_canonical_graph,
    },
    lexer::{Token, TokenKind},
    minimal_std::{HostBackedBridge, SystemHost},
    multi_module::{execute_native_multi_module_gate, serialize_native_multi_module_gate_report},
    node_free::{
        NODE_FREE_BENCHMARK_SCHEMA, NODE_FREE_REPORT_SCHEMA, NativeCandidate, NativeSample,
        NativeWorkloadEvidence, NodeFreeReport, serialize_node_free_report, stable_digest,
        workload_digest, workload_semantic_digest,
    },
    parser::{parse_source, tokenize_source},
    project::{
        NativeExport, NativeInterface, NativeModule, NativePackage, NativeProjectModule,
        build_project, load_project_directory, parse_json, serialize_build_manifest,
        serialize_project_graph, serialize_project_manifest, validate_enterprise_project_scale,
    },
    project_runtime::{
        NativeProjectExecutionPlan, execute_project_execution_plan,
        execute_project_execution_plan_cached, execute_project_execution_plan_direct,
        execute_project_module, parse_project_execution_plan, serialize_project_execution,
        serialize_project_execution_plan, serialize_project_run, serialize_project_translation,
        translate_project_module,
    },
    release::{
        build_release_candidate, install_release_candidate, rollback_release,
        serialize_platform_matrix, verify_release_candidate,
    },
    release_evidence::{
        NATIVE_PROJECT_CAPABILITY_COMPARISON_SCHEMA, NativeComparisonCandidate,
        NativeDeterministicBuildEvidence, NativeReleaseRun, build_native_release_evidence,
        serialize_native_release_evidence,
    },
    replay::{ReplayBridge, parse_native_replay_transcript, serialize_native_replay_transcript},
    replay_catalog::{
        ReplayWorkloadObservation, build_replay_workload_report, parse_replay_workload_catalog,
        serialize_replay_workload_report,
    },
    replay_fault_catalog::{
        ReplayFaultKind, ReplayFaultResult, ReplayFaultWorkloadObservation,
        build_replay_fault_report, parse_replay_fault_catalog, serialize_replay_fault_report,
    },
    runtime_bundle::{
        RUNTIME_BUNDLE_SCHEMA, build_runtime_bundle, serialize_runtime_bundle,
        verify_runtime_bundle,
    },
    runtime_bundle_comparison::{
        BUNDLE_COMPARISON_SCHEMA, BundleComparisonObservation, BundleComparisonReport,
        ProjectRunAuthority, parse_bundle_comparison_report, serialize_bundle_comparison_report,
    },
    server::{
        HttpHandler, HttpLimits, HttpRequest, HttpResponse, HttpRoute, HttpRouter, JsonKind,
        JsonSchema, JsonSchemaRegistry, ServerCancellation, ServerError, SqlStatement, SqlValue,
        SqliteCliDriver, serve_once,
    },
    server_gate::{
        NATIVE_PROJECT_SERVER_GATE_SCHEMA, NATIVE_PROJECT_SERVER_RESPONSE_SCHEMA,
        NativeProjectServerGateReport, serialize_native_project_server_gate_report,
        server_gate_report_digest,
    },
    source::SourceText,
    vm::{VmLimits, execute_bytecode},
};

const CHECK_SCHEMA: &str = "re.native-parser-result@0.1.0";
const LEX_SCHEMA: &str = "re.native-lexer-result@0.1.0";
const PROJECT_BENCHMARK_SCHEMA: &str = "re.native-project-benchmark@0.1.0";
const PROJECT_TEST_SCHEMA: &str = "re.native-project-test@0.1.0";
const PROJECT_INIT_PROFILE_DIGEST: &str =
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PROJECT_INIT_TOOLCHAIN_DIGEST: &str =
    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PROJECT_INIT_SOURCE: &str = include_str!("../../../examples/hello.re");
const PROJECT_CAPABILITY_ENTRY_RESULT: &str = "process.status@0.1.0";
const RUNTIME_BUNDLE_VERIFICATION_SCHEMA: &str = "re.native-runtime-bundle-verification@0.1.0";
const DEVELOPER_GATE_SCHEMA: &str = "re.native-developer-gate@0.1.0";
const TOOLCHAIN_GATE_SCHEMA: &str = "re.native-toolchain-gate@0.1.0";
static TEMP_WORKSPACE_COUNTER: AtomicU64 = AtomicU64::new(0);
const CLI_HELP: &str = r#"revia native 1.0.0-rc.2.2

Usage:
  revia <command> [arguments]

Commands:
  check <file>
  lex <file>
  digest <file>
  canonical <file>
  manifest <file>
  translate <file>
  compile <source> <artifact>
  execute <source> <input-digest>
  runtime-package <source> <bundle>
  runtime-verify <bundle>
  runtime-run <bundle> <input-digest> <sandbox>
  task-request <config.json> <request.json> <sandbox> <bundle.json> <review.json>
  approval-authority <socket> <state-dir> <policy.json>
  task-run <bundle.json> <approval-socket> <sandbox>
  capability-comparison <catalog> <output>
  capability-project-comparison <catalog> <project> <cache> <build> <profile-digest> <toolchain-digest> <output>
  bundle-comparison <catalog> <project> <output>
  conformance-run <source> <input-digest> <transcript>
  cross-language-matrix <source> <input-digest> <transcript> <node-result> <output>
  replay-catalog <catalog> <output>
  comparison-catalog <catalog> <project> <output>
  experiment-kit <catalog> <project> <output>
  replay-fault-catalog <catalog> <output>
  replay-fault-corpus <corpus> <output>
  replay-fault-corpus-gate <corpus> <evidence>
  verify <graph> <artifact>
  run <graph> <artifact> <input-digest>
  project-init <directory>
  project-check <project>
  project-test <project>
  project-scale <project>
  project-build <project> <cache> <build> <profile-digest> <toolchain-digest>
  project-translate <project> <cache> <build> <profile-digest> <toolchain-digest> <module>
  project-run <project> <cache> <build> <profile-digest> <toolchain-digest> <module> <input-digest>
  project-run-sandbox <project> <cache> <build> <profile-digest> <toolchain-digest> <module> <input-digest> <sandbox>
  project-execute <project> <module> <profile-digest> <toolchain-digest> <input-digest>
  project-execute-plan <project> <plan> <profile-digest> <toolchain-digest> <input-digest>
  project-execute-plan-direct <project> <plan> <profile-digest> <toolchain-digest> <input-digest>
  project-execute-plan-cached <project> <plan> <execution-cache> <profile-digest> <toolchain-digest> <input-digest>
  project-multi-module-gate <project> <plan> <profile-digest> <toolchain-digest> <input-digest> <report>
  project-server-gate <project> <plan> <profile-digest> <toolchain-digest> <input-digest> <sqlite-executable> <database> <report>
  project-benchmark <project> <module> <profile-digest> <toolchain-digest> <input-digest> <report>
  server-smoke
  project-server-smoke <project> <module> <profile-digest> <toolchain-digest> <input-digest>
  release-package <binary> <candidate> <target> <source-digest> <toolchain-digest>
  release-verify <candidate> <target> <source-digest> <toolchain-digest>
  release-install <candidate> <install> <target> <source-digest> <toolchain-digest>
  release-rollback <install> <target> <source-digest> <toolchain-digest>
  release-matrix <target> <output>
  node-free-gate <source> <project> <module> <report>
  developer-gate <project> <module> <input-digest> <report>
  toolchain-gate <source> <project> <module> <input-digest> <report>
  release-evidence-gate <source> <project> <module> <fault-corpus> <evidence>

Use `revia <command> --help` for a command's arguments.
"#;
const CLI_EXIT_CODES: &str = "Exit codes:\n  0  success\n  64 usage or unknown command\n  65 source, project, or contract failure\n";

fn main() {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    let result = match arguments.as_slice() {
        [command] if command == "--help" || command == "help" => cli_help(),
        [command, topic] if command == "help" => command_help(topic),
        [command, flag] if flag == "--help" => command_help(command),
        [command, path] if command == "check" => check(path),
        [command, path] if command == "lex" => lex(path),
        [command, path] if command == "digest" => digest(path),
        [command, path] if command == "canonical" => canonical(path),
        [command, path] if command == "manifest" => manifest(path),
        [command, path] if command == "translate" => translate(path),
        [command, source_path, artifact_path] if command == "compile" => {
            compile(source_path, artifact_path)
        }
        [command, source_path, input_digest] if command == "execute" => {
            execute(source_path, input_digest)
        }
        [command, source_path, bundle_path] if command == "runtime-package" => {
            runtime_package(source_path, bundle_path)
        }
        [command, bundle_path] if command == "runtime-verify" => runtime_verify(bundle_path),
        [command, bundle_path, input_digest, sandbox_path] if command == "runtime-run" => {
            runtime_run(bundle_path, input_digest, sandbox_path)
        }
        [command, catalog_path, output_path] if command == "capability-comparison" => {
            capability_comparison(catalog_path, output_path)
        }
        [
            command,
            catalog_path,
            project_path,
            cache_path,
            build_path,
            profile_digest,
            toolchain_digest,
            output_path,
        ] if command == "capability-project-comparison" => capability_project_comparison(
            catalog_path,
            project_path,
            cache_path,
            build_path,
            profile_digest,
            toolchain_digest,
            output_path,
        ),
        [command, catalog_path, project_path, output_path] if command == "bundle-comparison" => {
            bundle_comparison(catalog_path, project_path, output_path)
        }
        [command, source_path, input_digest, transcript_path] if command == "conformance-run" => {
            conformance_run(source_path, input_digest, transcript_path)
        }
        [
            command,
            source_path,
            input_digest,
            transcript_path,
            node_result_path,
            output_path,
        ] if command == "cross-language-matrix" => cross_language_matrix(
            source_path,
            input_digest,
            transcript_path,
            node_result_path,
            output_path,
        ),
        [command, catalog_path, output_path] if command == "replay-catalog" => {
            replay_catalog(catalog_path, output_path)
        }
        [command, catalog_path, project_path, output_path] if command == "comparison-catalog" => {
            comparison_catalog(catalog_path, project_path, output_path)
        }
        [command, catalog_path, project_path, output_path] if command == "experiment-kit" => {
            experiment_kit(catalog_path, project_path, output_path)
        }
        [command, catalog_path, output_path] if command == "replay-fault-catalog" => {
            replay_fault_catalog(catalog_path, output_path)
        }
        [command, corpus_path, output_path] if command == "replay-fault-corpus" => {
            replay_fault_corpus(corpus_path, output_path)
        }
        [command, corpus_path, evidence_path] if command == "replay-fault-corpus-gate" => {
            replay_fault_corpus_gate(corpus_path, evidence_path)
        }
        [command, graph_path, artifact_path] if command == "verify" => {
            verify(graph_path, artifact_path)
        }
        [command, graph_path, artifact_path, input_digest] if command == "run" => {
            run(graph_path, artifact_path, input_digest)
        }
        [command, project_path] if command == "project-check" => project_check(project_path),
        [command, project_path] if command == "project-init" => project_init(project_path),
        [command, project_path] if command == "project-test" => project_test(project_path),
        [command, project_path] if command == "project-scale" => project_scale(project_path),
        [
            command,
            project_path,
            plan_path,
            profile_digest,
            toolchain_digest,
            input_digest,
        ] if command == "project-execute-plan" => project_execute_plan(
            project_path,
            plan_path,
            profile_digest,
            toolchain_digest,
            input_digest,
        ),
        [
            command,
            project_path,
            plan_path,
            profile_digest,
            toolchain_digest,
            input_digest,
        ] if command == "project-execute-plan-direct" => project_execute_plan_direct(
            project_path,
            plan_path,
            profile_digest,
            toolchain_digest,
            input_digest,
        ),
        [
            command,
            project_path,
            plan_path,
            execution_cache_path,
            profile_digest,
            toolchain_digest,
            input_digest,
        ] if command == "project-execute-plan-cached" => project_execute_plan_cached(
            project_path,
            plan_path,
            execution_cache_path,
            profile_digest,
            toolchain_digest,
            input_digest,
        ),
        [
            command,
            project_path,
            plan_path,
            profile_digest,
            toolchain_digest,
            input_digest,
            report_path,
        ] if command == "project-multi-module-gate" => project_multi_module_gate(
            project_path,
            plan_path,
            profile_digest,
            toolchain_digest,
            input_digest,
            report_path,
        ),
        [
            command,
            project_path,
            plan_path,
            profile_digest,
            toolchain_digest,
            input_digest,
            sqlite_executable,
            database_path,
            report_path,
        ] if command == "project-server-gate" => project_server_gate(
            project_path,
            plan_path,
            profile_digest,
            toolchain_digest,
            input_digest,
            sqlite_executable,
            database_path,
            report_path,
        ),
        [
            command,
            project_path,
            module_name,
            profile_digest,
            toolchain_digest,
            input_digest,
        ] if command == "project-execute" => project_execute(
            project_path,
            module_name,
            profile_digest,
            toolchain_digest,
            input_digest,
        ),
        [
            command,
            project_path,
            module_name,
            profile_digest,
            toolchain_digest,
            input_digest,
            report_path,
        ] if command == "project-benchmark" => project_benchmark(
            project_path,
            module_name,
            profile_digest,
            toolchain_digest,
            input_digest,
            report_path,
        ),
        [
            command,
            project_path,
            cache_path,
            build_path,
            profile_digest,
            toolchain_digest,
            module_name,
        ] if command == "project-translate" => project_translate(
            project_path,
            cache_path,
            build_path,
            profile_digest,
            toolchain_digest,
            module_name,
        ),
        [
            command,
            project_path,
            cache_path,
            build_path,
            profile_digest,
            toolchain_digest,
            module_name,
            input_digest,
        ] if command == "project-run" => project_run(
            project_path,
            cache_path,
            build_path,
            profile_digest,
            toolchain_digest,
            module_name,
            input_digest,
        ),
        [
            command,
            project_path,
            cache_path,
            build_path,
            profile_digest,
            toolchain_digest,
            module_name,
            input_digest,
            sandbox_path,
        ] if command == "project-run-sandbox" => project_run_sandbox(
            project_path,
            cache_path,
            build_path,
            profile_digest,
            toolchain_digest,
            module_name,
            input_digest,
            sandbox_path,
        ),
        [
            command,
            project_path,
            cache_path,
            build_path,
            profile_digest,
            toolchain_digest,
        ] if command == "project-build" => project_build(
            project_path,
            cache_path,
            build_path,
            profile_digest,
            toolchain_digest,
        ),
        [command] if command == "server-smoke" => server_smoke(),
        [
            command,
            project_path,
            module_name,
            profile_digest,
            toolchain_digest,
            input_digest,
        ] if command == "project-server-smoke" => project_server_smoke(
            project_path,
            module_name,
            profile_digest,
            toolchain_digest,
            input_digest,
        ),
        [
            command,
            binary_path,
            output_path,
            target,
            source_digest,
            toolchain_digest,
        ] if command == "release-package" => release_package(
            binary_path,
            output_path,
            target,
            source_digest,
            toolchain_digest,
        ),
        [
            command,
            candidate_path,
            target,
            source_digest,
            toolchain_digest,
        ] if command == "release-verify" => {
            release_verify(candidate_path, target, source_digest, toolchain_digest)
        }
        [
            command,
            candidate_path,
            install_path,
            target,
            source_digest,
            toolchain_digest,
        ] if command == "release-install" => release_install(
            candidate_path,
            install_path,
            target,
            source_digest,
            toolchain_digest,
        ),
        [
            command,
            install_path,
            target,
            source_digest,
            toolchain_digest,
        ] if command == "release-rollback" => {
            release_rollback(install_path, target, source_digest, toolchain_digest)
        }
        [command, target, output_path] if command == "release-matrix" => {
            release_matrix(target, output_path)
        }
        [command, source_path, project_path, module_name, report_path]
            if command == "node-free-gate" =>
        {
            node_free_gate(source_path, project_path, module_name, report_path)
        }
        [
            command,
            project_path,
            module_name,
            input_digest,
            report_path,
        ] if command == "developer-gate" => {
            developer_gate(project_path, module_name, input_digest, report_path)
        }
        [
            command,
            source_path,
            project_path,
            module_name,
            input_digest,
            report_path,
        ] if command == "toolchain-gate" => toolchain_gate(
            source_path,
            project_path,
            module_name,
            input_digest,
            report_path,
        ),
        [
            command,
            source_path,
            project_path,
            module_name,
            corpus_path,
            evidence_path,
        ] if command == "release-evidence-gate" => release_evidence_gate(
            source_path,
            project_path,
            module_name,
            corpus_path,
            evidence_path,
        ),
        [command] if command == "--version" => {
            println!("revia native 1.0.0-rc.2.2");
            Ok(())
        }
        _ => {
            eprintln!(
                "Usage: revia <check|lex|digest|canonical|manifest|translate> <file> | compile <source> <artifact> | execute <source> <input-digest> | runtime-package <source> <bundle> | runtime-verify <bundle> | runtime-run <bundle> <input-digest> <sandbox> | capability-comparison <catalog> <output> | capability-project-comparison <catalog> <project> <cache> <build> <profile-digest> <toolchain-digest> <output> | conformance-run <source> <input-digest> <transcript> | cross-language-matrix <source> <input-digest> <transcript> <node-result> <output> | replay-catalog <catalog> <output> | comparison-catalog <catalog> <project> <output> | experiment-kit <catalog> <project> <output> | replay-fault-catalog <catalog> <output> | replay-fault-corpus <corpus> <output> | replay-fault-corpus-gate <corpus> <evidence> | verify <graph> <artifact> | run <graph> <artifact> <input-digest> | project-init <directory> | project-check <project> | project-test <project> | project-scale <project> | project-execute-plan <project> <plan> <profile-digest> <toolchain-digest> <input-digest> | project-execute-plan-direct <project> <plan> <profile-digest> <toolchain-digest> <input-digest> | project-execute-plan-cached <project> <plan> <execution-cache> <profile-digest> <toolchain-digest> <input-digest> | project-execute <project> <module> <profile-digest> <toolchain-digest> <input-digest> | project-benchmark <project> <module> <profile-digest> <toolchain-digest> <input-digest> <report> | project-translate <project> <cache> <build> <profile-digest> <toolchain-digest> <module> | project-run <project> <cache> <build> <profile-digest> <toolchain-digest> <module> <input-digest> | project-run-sandbox <project> <cache> <build> <profile-digest> <toolchain-digest> <module> <input-digest> <sandbox> | project-build <project> <cache> <build> <profile-digest> <toolchain-digest> | server-smoke | project-server-smoke <project> <module> <profile-digest> <toolchain-digest> <input-digest> | release-package <binary> <candidate> <target> <source-digest> <toolchain-digest> | release-verify <candidate> <target> <source-digest> <toolchain-digest> | release-install <candidate> <target> <source-digest> <toolchain-digest> | release-rollback <install> <target> <source-digest> <toolchain-digest> | release-matrix <target> <output> | node-free-gate <source> <project> <module> <report> | developer-gate <project> <module> <input-digest> <report> | toolchain-gate <source> <project> <module> <input-digest> <report> | release-evidence-gate <source> <project> <module> <fault-corpus> <evidence>"
            );
            Err(64)
        }
    };
    if let Err(code) = result {
        process::exit(code);
    }
}

fn cli_help() -> Result<(), i32> {
    print!("{CLI_HELP}{CLI_EXIT_CODES}");
    Ok(())
}

fn command_help(command: &str) -> Result<(), i32> {
    let usage = match command {
        "check" => {
            "revia check <file>\n  Validate a source file and emit the native parser result.\n  Invalid source or contract: exit 65.\n"
        }
        "lex" => "revia lex <file>\n  Tokenize a source file.\n",
        "digest" => "revia digest <file>\n  Print the source digest.\n",
        "canonical" => "revia canonical <file>\n  Load and print canonical RE.\n",
        "manifest" => "revia manifest <file>\n  Print the checked graph manifest.\n",
        "translate" => "revia translate <file>\n  Translate a checked graph.\n",
        "compile" => "revia compile <source> <artifact>\n  Write a verified native artifact.\n",
        "execute" => {
            "revia execute <source> <input-digest>\n  Check, translate, and execute one source file.\n"
        }
        "runtime-package" => {
            "revia runtime-package <source> <bundle>\n  Package a verified graph and artifact into a movable native runtime bundle.\n"
        }
        "runtime-verify" => {
            "revia runtime-verify <bundle>\n  Verify a native runtime bundle offline without running program effects.\n"
        }
        "runtime-run" => {
            "revia runtime-run <bundle> <input-digest> <sandbox>\n  Verify and execute a native runtime bundle in an explicit filesystem sandbox.\n"
        }
        "task-request" => {
            "revia task-request <config.json> <request.json> <sandbox> <bundle.json> <review.json>\n  Reserved WP-313 reviewed-task entry; unavailable until approval-authority peer identity is verified.\n"
        }
        "approval-authority" => {
            "revia approval-authority <socket> <state-dir> <policy.json>\n  Reserved WP-313 approval service entry; unavailable until peer identity is verified.\n"
        }
        "task-run" => {
            "revia task-run <bundle.json> <approval-socket> <sandbox>\n  Reserved WP-313 controlled execution entry; unavailable until peer identity is verified.\n"
        }
        "capability-comparison" => {
            "revia capability-comparison <catalog> <output>\n  Compare direct native effects with a movable runtime bundle in isolated sandboxes.\n"
        }
        "capability-project-comparison" => {
            "revia capability-project-comparison <catalog> <project> <cache> <build> <profile-digest> <toolchain-digest> <output>\n  Compare project-run, direct native effects, and a movable runtime bundle in isolated sandboxes.\n"
        }
        "bundle-comparison" => {
            "revia bundle-comparison <catalog> <project> <output>\n  Compare movable runtime bundles with direct native execution for applicable workloads.\n"
        }
        "conformance-run" => {
            "revia conformance-run <source> <input-digest> <transcript>\n  Execute against a canonical replay transcript.\n"
        }
        "cross-language-matrix" => {
            "revia cross-language-matrix <source> <input-digest> <transcript> <node-result> <output>\n  Compare native output with a supplied Node oracle.\n"
        }
        "replay-catalog" => {
            "revia replay-catalog <catalog> <output>\n  Run the replay workload catalog.\n"
        }
        "comparison-catalog" => {
            "revia comparison-catalog <catalog> <project> <output>\n  Run the native comparison catalog.\n"
        }
        "experiment-kit" => {
            "revia experiment-kit <catalog> <project> <output>\n  Build a canonical cross-language experiment kit with native evidence and pending backend partitions.\n"
        }
        "replay-fault-catalog" => {
            "revia replay-fault-catalog <catalog> <output>\n  Run the closed fault catalog.\n"
        }
        "replay-fault-corpus" => {
            "revia replay-fault-corpus <corpus> <output>\n  Run the native fault corpus.\n"
        }
        "replay-fault-corpus-gate" => {
            "revia replay-fault-corpus-gate <corpus> <evidence>\n  Verify release fault evidence.\n"
        }
        "verify" => "revia verify <graph> <artifact>\n  Verify a graph-bound artifact.\n",
        "run" => "revia run <graph> <artifact> <input-digest>\n  Execute a verified artifact.\n",
        "project-init" => {
            "revia project-init <directory>\n  Create a deterministic starter project.\n"
        }
        "project-check" => {
            "revia project-check <project>\n  Check a project manifest and module graph.\n"
        }
        "project-test" => {
            "revia project-test <project>\n  Translate each project module in dependency order.\n"
        }
        "project-scale" => {
            "revia project-scale <project>\n  Validate the bounded enterprise fixture.\n"
        }
        "project-build" => {
            "revia project-build <project> <cache> <build> <profile-digest> <toolchain-digest>\n  Build a project with its digest-bound cache.\n"
        }
        "project-translate" => {
            "revia project-translate <project> <cache> <build> <profile-digest> <toolchain-digest> <module>\n  Translate one project module.\n"
        }
        "project-run" => {
            "revia project-run <project> <cache> <build> <profile-digest> <toolchain-digest> <module> <input-digest>\n  Execute one project module.\n"
        }
        "project-run-sandbox" => {
            "revia project-run-sandbox <project> <cache> <build> <profile-digest> <toolchain-digest> <module> <input-digest> <sandbox>\n  Execute one project module against an explicit external filesystem sandbox.\n"
        }
        "project-execute" => {
            "revia project-execute <project> <module> <profile-digest> <toolchain-digest> <input-digest>\n  Execute a project module through the direct runner.\n"
        }
        "project-execute-plan" => {
            "revia project-execute-plan <project> <plan> <profile-digest> <toolchain-digest> <input-digest>\n  Execute a verified project plan.\n"
        }
        "project-execute-plan-direct" => {
            "revia project-execute-plan-direct <project> <plan> <profile-digest> <toolchain-digest> <input-digest>\n  Execute a plan through the direct runner.\n"
        }
        "project-execute-plan-cached" => {
            "revia project-execute-plan-cached <project> <plan> <execution-cache> <profile-digest> <toolchain-digest> <input-digest>\n  Execute a plan through the verified execution cache.\n"
        }
        "project-multi-module-gate" => {
            "revia project-multi-module-gate <project> <plan> <profile-digest> <toolchain-digest> <input-digest> <report>\n  Build, translate, and execute a verified multi-module project plan.\n"
        }
        "project-server-gate" => {
            "revia project-server-gate <project> <plan> <profile-digest> <toolchain-digest> <input-digest> <sqlite-executable> <database> <report>\n  Exercise a verified multi-module project through the bounded Server profile.\n"
        }
        "project-benchmark" => {
            "revia project-benchmark <project> <module> <profile-digest> <toolchain-digest> <input-digest> <report>\n  Record bounded project benchmark evidence.\n"
        }
        "server-smoke" => "revia server-smoke\n  Run the bounded Server profile smoke.\n",
        "project-server-smoke" => {
            "revia project-server-smoke <project> <module> <profile-digest> <toolchain-digest> <input-digest>\n  Run a project Server profile smoke.\n"
        }
        "release-package" => {
            "revia release-package <binary> <candidate> <target> <source-digest> <toolchain-digest>\n  Package a verified native release candidate.\n"
        }
        "release-verify" => {
            "revia release-verify <candidate> <target> <source-digest> <toolchain-digest>\n  Verify a release candidate.\n"
        }
        "release-install" => {
            "revia release-install <candidate> <install> <target> <source-digest> <toolchain-digest>\n  Install a verified release candidate.\n"
        }
        "release-rollback" => {
            "revia release-rollback <install> <target> <source-digest> <toolchain-digest>\n  Roll back to a retained release.\n"
        }
        "release-matrix" => {
            "revia release-matrix <target> <output>\n  Print the supported release matrix.\n"
        }
        "node-free-gate" => {
            "revia node-free-gate <source> <project> <module> <report>\n  Run the native Node-free gate.\n"
        }
        "developer-gate" => {
            "revia developer-gate <project> <module> <input-digest> <report>\n  Run the native developer conformance and reproducibility gate.\n"
        }
        "toolchain-gate" => {
            "revia toolchain-gate <source> <project> <module> <input-digest> <report>\n  Verify the standalone native translator and executor toolchain.\n"
        }
        "release-evidence-gate" => {
            "revia release-evidence-gate <source> <project> <module> <fault-corpus> <evidence>\n  Build fresh native release evidence.\n"
        }
        _ => {
            eprintln!("Unknown command for help: {command}");
            return Err(64);
        }
    };
    print!("{usage}");
    Ok(())
}

fn release_package(
    binary_path: &str,
    output_path: &str,
    target: &str,
    source_digest: &str,
    toolchain_digest: &str,
) -> Result<(), i32> {
    release_result(build_release_candidate(
        binary_path,
        output_path,
        target,
        source_digest,
        toolchain_digest,
    ))
}

fn release_verify(
    candidate_path: &str,
    target: &str,
    source_digest: &str,
    toolchain_digest: &str,
) -> Result<(), i32> {
    release_result(verify_release_candidate(
        candidate_path,
        target,
        source_digest,
        toolchain_digest,
    ))
}

fn release_install(
    candidate_path: &str,
    install_path: &str,
    target: &str,
    source_digest: &str,
    toolchain_digest: &str,
) -> Result<(), i32> {
    release_result(install_release_candidate(
        candidate_path,
        install_path,
        target,
        source_digest,
        toolchain_digest,
    ))
}

fn release_rollback(
    install_path: &str,
    target: &str,
    source_digest: &str,
    toolchain_digest: &str,
) -> Result<(), i32> {
    release_result(rollback_release(
        install_path,
        target,
        source_digest,
        toolchain_digest,
    ))
}

fn release_matrix(target: &str, output_path: &str) -> Result<(), i32> {
    let output = match serialize_platform_matrix(target) {
        Ok(output) => output,
        Err(error) => {
            print_release_error(&error.code);
            return Err(65);
        }
    };
    if write_atomic(Path::new(output_path), output.as_bytes()).is_err() {
        print_release_error("native-release-matrix-write-failure");
        return Err(74);
    }
    print!("{output}");
    Ok(())
}

fn release_result(result: Result<String, revia_core::release::ReleaseError>) -> Result<(), i32> {
    match result {
        Ok(output) => {
            print!("{output}");
            Ok(())
        }
        Err(error) => {
            print_release_error(&error.code);
            Err(65)
        }
    }
}

fn compile(source_path: &str, artifact_path: &str) -> Result<(), i32> {
    let graph = read_graph(source_path)?;
    let artifact = translate_graph(&graph).map_err(|error| {
        print_graph_error(&error);
        65
    })?;
    let bytes = serialize_bytecode_artifact(&artifact).map_err(|error| {
        print_graph_error(&error);
        65
    })?;
    verify_bytecode_artifact(&graph, &bytes).map_err(|error| {
        print_graph_error(&error);
        65
    })?;
    if write_atomic(Path::new(artifact_path), bytes.as_bytes()).is_err() {
        print_compile_error("native-compile-write-failure");
        return Err(74);
    }
    println!(
        "{{\"artifact_digest\":{},\"graph_revision\":{},\"ok\":true,\"schema\":{}}}",
        quote(&artifact.artifact_digest),
        quote(&artifact.graph_revision),
        quote("re.native-compile-result@0.1.0"),
    );
    Ok(())
}

fn execute(source_path: &str, input_digest: &str) -> Result<(), i32> {
    let graph = read_graph(source_path)?;
    let artifact = translate_graph(&graph).map_err(|error| {
        print_graph_error(&error);
        65
    })?;
    let artifact_source = serialize_bytecode_artifact(&artifact).map_err(|error| {
        print_graph_error(&error);
        65
    })?;
    let request = revia_core::vm::VmRequest::new(
        revia_core::graph::graph_revision(&graph).map_err(|_| 65)?,
        artifact.artifact_digest.clone(),
        artifact.profile.clone(),
        input_digest,
    );
    let (mut bridge, program_stdout) = system_host_bridge(&graph, source_path, input_digest)
        .map_err(|code| {
            print_host_executor_error(&code);
            65
        })?;
    let result = execute_bytecode(
        &graph,
        &artifact_source,
        &request,
        &mut bridge,
        VmLimits::default(),
    )
    .map_err(|error| {
        print_host_executor_error(&error.code);
        65
    })?;
    print_host_vm_result(&result, &program_stdout).map_err(|code| {
        print_host_executor_error(&code);
        65
    })?;
    Ok(())
}

fn runtime_package(source_path: &str, bundle_path: &str) -> Result<(), i32> {
    let graph = read_graph(source_path)?;
    let artifact = translate_graph(&graph).map_err(|error| {
        print_graph_error(&error);
        65
    })?;
    let artifact_source = serialize_bytecode_artifact(&artifact).map_err(|error| {
        print_graph_error(&error);
        65
    })?;
    let bundle = build_runtime_bundle(&graph, &artifact_source).map_err(|error| {
        print_runtime_bundle_error(&error.code);
        65
    })?;
    let output = serialize_runtime_bundle(&bundle).map_err(|error| {
        print_runtime_bundle_error(&error.code);
        65
    })?;
    if write_atomic(Path::new(bundle_path), output.as_bytes()).is_err() {
        print_runtime_bundle_error("native-runtime-bundle-write-failure");
        return Err(74);
    }
    print!("{output}");
    Ok(())
}

fn runtime_verify(bundle_path: &str) -> Result<(), i32> {
    let bundle_source = fs::read_to_string(bundle_path).map_err(|_| {
        print_runtime_bundle_error("native-runtime-bundle-unreadable");
        66
    })?;
    let bundle = verify_runtime_bundle(&bundle_source).map_err(|error| {
        print_runtime_bundle_error(&error.code);
        65
    })?;
    let output = JsonValue::Object(vec![
        (
            "artifact_digest".to_owned(),
            JsonValue::String(bundle.artifact_digest.clone()),
        ),
        (
            "bundle_digest".to_owned(),
            JsonValue::String(bundle.bundle_digest.clone()),
        ),
        (
            "graph_revision".to_owned(),
            JsonValue::String(bundle.graph_revision.clone()),
        ),
        ("ok".to_owned(), JsonValue::Bool(true)),
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
            JsonValue::String(RUNTIME_BUNDLE_VERIFICATION_SCHEMA.to_owned()),
        ),
        (
            "source_digest".to_owned(),
            JsonValue::String(bundle.source_digest.clone()),
        ),
        (
            "translator".to_owned(),
            JsonValue::String(bundle.translator.clone()),
        ),
    ]);
    println!("{}", canonicalize(&output));
    Ok(())
}

fn runtime_run(bundle_path: &str, input_digest: &str, sandbox_path: &str) -> Result<(), i32> {
    let bundle_source = fs::read_to_string(bundle_path).map_err(|_| {
        print_runtime_bundle_error("native-runtime-bundle-unreadable");
        66
    })?;
    let bundle = verify_runtime_bundle(&bundle_source).map_err(|error| {
        print_runtime_bundle_error(&error.code);
        65
    })?;
    if !is_valid_digest(input_digest) {
        print_runtime_bundle_error("native-vm-request-input-digest-invalid");
        return Err(65);
    }
    let graph = load_canonical_graph(&bundle.canonical_source).map_err(|error| {
        print_runtime_bundle_error(&error.code);
        65
    })?;
    let artifact =
        revia_core::bytecode::load_bytecode_artifact(&bundle.artifact).map_err(|error| {
            print_runtime_bundle_error(&error.code);
            65
        })?;
    let sandbox = absolute_input_path(Path::new(sandbox_path)).map_err(|_| {
        print_runtime_bundle_error("native-runtime-bundle-sandbox-invalid");
        65
    })?;
    let metadata = fs::symlink_metadata(&sandbox).map_err(|_| {
        print_runtime_bundle_error("native-runtime-bundle-sandbox-invalid");
        65
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        print_runtime_bundle_error("native-runtime-bundle-sandbox-invalid");
        return Err(65);
    }
    let request = revia_core::vm::VmRequest::new(
        bundle.graph_revision.clone(),
        artifact.artifact_digest.clone(),
        artifact.profile.clone(),
        input_digest,
    );
    let (mut bridge, program_stdout) =
        system_host_bridge_for_sandbox(&graph, &sandbox, input_digest).map_err(|code| {
            print_runtime_bundle_error(&code);
            65
        })?;
    let result = execute_bytecode(
        &graph,
        &bundle.artifact,
        &request,
        &mut bridge,
        VmLimits::default(),
    )
    .map_err(|error| {
        print_runtime_bundle_error(&error.code);
        65
    })?;
    print_host_vm_result(&result, &program_stdout).map_err(|code| {
        print_runtime_bundle_error(&code);
        65
    })?;
    Ok(())
}

fn capability_comparison(catalog_path: &str, output_path: &str) -> Result<(), i32> {
    let output_path = absolute_input_path(Path::new(output_path)).map_err(|_| 66)?;
    let result = (|| -> Result<String, String> {
        let catalog_path = absolute_input_path(Path::new(catalog_path))?;
        let catalog_source = fs::read_to_string(&catalog_path)
            .map_err(|_| "native-capability-comparison-catalog-unreadable".to_owned())?;
        let catalog =
            parse_capability_comparison_catalog(&catalog_source).map_err(|error| error.code)?;
        let binary = env::current_exe()
            .map_err(|_| "native-capability-comparison-binary-unreadable".to_owned())?;
        let root = native_temp_root("capability-comparison");
        let empty_path = root.join("empty-path");
        fs::create_dir_all(&empty_path)
            .map_err(|_| "native-capability-comparison-workspace-failure".to_owned())?;
        let comparison = (|| -> Result<String, String> {
            let mut process_count = 0;
            let mut observations = Vec::with_capacity(catalog.workloads.len());
            for (index, workload) in catalog.workloads.iter().enumerate() {
                let workdir = root.join(format!("work-{index}"));
                let direct_root = workdir.join("direct");
                let bundle_root = workdir.join("bundle");
                fs::create_dir_all(&direct_root)
                    .and_then(|_| fs::create_dir_all(&bundle_root))
                    .map_err(|_| "native-capability-comparison-workspace-failure".to_owned())?;
                materialize_capability_files(&direct_root, &workload.sandbox_before)?;
                materialize_capability_files(&bundle_root, &workload.sandbox_before)?;
                let source_path = workdir.join("source.re");
                let bundle_path = workdir.join("runtime.rebundle");
                fs::write(&source_path, workload.source.as_bytes())
                    .map_err(|_| "native-capability-comparison-source-write-failure".to_owned())?;
                let packaged = run_native_command(
                    &binary,
                    &empty_path,
                    &workdir,
                    &[
                        "runtime-package".to_owned(),
                        source_path.to_string_lossy().into_owned(),
                        bundle_path.to_string_lossy().into_owned(),
                    ],
                    &mut process_count,
                )?;
                require_success("runtime-package", &packaged)?;

                let direct_source = direct_root.join("source.re");
                fs::write(&direct_source, workload.source.as_bytes())
                    .map_err(|_| "native-capability-comparison-source-write-failure".to_owned())?;
                let direct = run_native_command(
                    &binary,
                    &empty_path,
                    &direct_root,
                    &[
                        "execute".to_owned(),
                        direct_source.to_string_lossy().into_owned(),
                        workload.input_digest.clone(),
                    ],
                    &mut process_count,
                )?;
                require_success("execute", &direct)?;

                let bundled = run_native_command(
                    &binary,
                    &empty_path,
                    &bundle_root,
                    &[
                        "runtime-run".to_owned(),
                        bundle_path.to_string_lossy().into_owned(),
                        workload.input_digest.clone(),
                        bundle_root.to_string_lossy().into_owned(),
                    ],
                    &mut process_count,
                )?;
                require_success("runtime-run", &bundled)?;
                if direct.stdout != bundled.stdout {
                    return Err("native-capability-comparison-result-mismatch".to_owned());
                }
                let direct_facts = parse_capability_execution_facts(&direct.stdout)?;
                let bundle_facts = parse_capability_execution_facts(&bundled.stdout)?;
                let direct_files = snapshot_capability_files(&direct_root, &["source.re"])?;
                let bundle_files = snapshot_capability_files(&bundle_root, &[])?;
                if direct_files != workload.sandbox_after || bundle_files != workload.sandbox_after
                {
                    return Err("native-capability-comparison-sandbox-effect-mismatch".to_owned());
                }
                let graph = load_canonical_graph(&workload.source)
                    .map_err(|error| error.code.to_owned())?;
                let graph_revision =
                    graph_revision(&graph).map_err(|error| error.code.to_owned())?;
                let before_sandbox_digest = capability_sandbox_digest(&workload.sandbox_before)
                    .map_err(|error| error.code)?;
                let direct_sandbox_digest =
                    capability_sandbox_digest(&direct_files).map_err(|error| error.code)?;
                let bundle_sandbox_digest =
                    capability_sandbox_digest(&bundle_files).map_err(|error| error.code)?;
                observations.push(CapabilityComparisonObservation {
                    workload_id: workload.workload_id.clone(),
                    operation: workload.operation.clone(),
                    graph_revision,
                    input_digest: workload.input_digest.clone(),
                    direct_stdout_digest: direct_facts.program_stdout_digest,
                    bundle_stdout_digest: bundle_facts.program_stdout_digest,
                    direct_result_digest: direct_facts.result_digest,
                    bundle_result_digest: bundle_facts.result_digest,
                    direct_receipt_digest: direct_facts.receipt_digest,
                    bundle_receipt_digest: bundle_facts.receipt_digest,
                    before_sandbox_digest,
                    direct_sandbox_digest,
                    bundle_sandbox_digest,
                    direct_outcome_code: direct_facts.outcome_code,
                    bundle_outcome_code: bundle_facts.outcome_code,
                    status: "matched".to_owned(),
                });
            }
            let report = build_capability_comparison_report(&catalog, observations)
                .map_err(|error| error.code)?;
            serialize_capability_comparison_report(&catalog, &report).map_err(|error| error.code)
        })();
        fs::remove_dir_all(&root).ok();
        comparison
    })();
    match result {
        Ok(output) => {
            if write_atomic(&output_path, output.as_bytes()).is_err() {
                eprintln!("native-capability-comparison-report-write-failure");
                return Err(74);
            }
            print!("{output}");
            Ok(())
        }
        Err(code) => {
            eprintln!(
                "{{\"diagnostics\":[{{\"code\":{}}}],\"ok\":false,\"schema\":{}}}",
                quote(&code),
                quote("re.native-capability-comparison-report@0.1.0")
            );
            Err(65)
        }
    }
}

fn capability_project_comparison(
    catalog_path: &str,
    project_path: &str,
    cache_path: &str,
    build_path: &str,
    profile_digest: &str,
    toolchain_digest: &str,
    output_path: &str,
) -> Result<(), i32> {
    let output_path = absolute_input_path(Path::new(output_path)).map_err(|_| 66)?;
    let result = (|| -> Result<String, String> {
        let catalog_path = absolute_input_path(Path::new(catalog_path))?;
        let project_path = absolute_input_path(Path::new(project_path))?;
        let cache_path = absolute_input_path(Path::new(cache_path))?;
        let build_path = absolute_input_path(Path::new(build_path))?;
        if path_is_inside_or_equal(&project_path, &output_path)
            || path_is_inside_or_equal(&project_path, &cache_path)
            || path_is_inside_or_equal(&project_path, &build_path)
            || normalized_path(&cache_path) == normalized_path(&build_path)
        {
            return Err(
                "native-capability-project-comparison-output-or-build-path-invalid".to_owned(),
            );
        }
        let catalog_source = fs::read_to_string(&catalog_path)
            .map_err(|_| "native-capability-project-comparison-catalog-unreadable".to_owned())?;
        let catalog = parse_capability_project_comparison_catalog(&catalog_source)
            .map_err(|error| error.code)?;
        let project = load_project_directory(&project_path).map_err(|error| error.code)?;
        validate_project_capability_authority(&project, &project_path, &catalog)?;
        let binary = env::current_exe()
            .map_err(|_| "native-capability-project-comparison-binary-unreadable".to_owned())?;
        let root = native_temp_root("capability-project-comparison");
        let empty_path = root.join("empty-path");
        fs::create_dir_all(&empty_path)
            .map_err(|_| "native-capability-project-comparison-workspace-failure".to_owned())?;
        let comparison = (|| -> Result<String, String> {
            let mut process_count = 0;
            let mut observations = Vec::with_capacity(catalog.workloads.len());
            for (index, workload) in catalog.workloads.iter().enumerate() {
                let workdir = root.join(format!("work-{index}"));
                let direct_root = workdir.join("direct");
                let bundle_root = workdir.join("bundle");
                let project_sandbox = workdir.join("project-sandbox");
                fs::create_dir_all(&direct_root)
                    .and_then(|_| fs::create_dir_all(&bundle_root))
                    .and_then(|_| fs::create_dir_all(&project_sandbox))
                    .map_err(|_| {
                        "native-capability-project-comparison-workspace-failure".to_owned()
                    })?;
                materialize_capability_files(&direct_root, &workload.sandbox_before)?;
                materialize_capability_files(&bundle_root, &workload.sandbox_before)?;
                materialize_capability_files(&project_sandbox, &workload.sandbox_before)?;

                let source_path = workdir.join("source.re");
                fs::write(&source_path, workload.source.as_bytes()).map_err(|_| {
                    "native-capability-project-comparison-source-write-failure".to_owned()
                })?;
                let bundle_path = workdir.join("runtime.rebundle");
                let packaged = run_native_command(
                    &binary,
                    &empty_path,
                    &workdir,
                    &[
                        "runtime-package".to_owned(),
                        source_path.to_string_lossy().into_owned(),
                        bundle_path.to_string_lossy().into_owned(),
                    ],
                    &mut process_count,
                )?;
                require_success("runtime-package", &packaged)?;

                let direct_source = direct_root.join("source.re");
                fs::write(&direct_source, workload.source.as_bytes()).map_err(|_| {
                    "native-capability-project-comparison-source-write-failure".to_owned()
                })?;
                let direct = run_native_command(
                    &binary,
                    &empty_path,
                    &direct_root,
                    &[
                        "execute".to_owned(),
                        direct_source.to_string_lossy().into_owned(),
                        workload.input_digest.clone(),
                    ],
                    &mut process_count,
                )?;
                require_success("execute", &direct)?;
                let bundled = run_native_command(
                    &binary,
                    &empty_path,
                    &bundle_root,
                    &[
                        "runtime-run".to_owned(),
                        bundle_path.to_string_lossy().into_owned(),
                        workload.input_digest.clone(),
                        bundle_root.to_string_lossy().into_owned(),
                    ],
                    &mut process_count,
                )?;
                require_success("runtime-run", &bundled)?;

                let project_cache = cache_path.join(format!("work-{index}"));
                let project_build = build_path.join(format!("work-{index}"));
                fs::create_dir_all(&project_cache)
                    .and_then(|_| fs::create_dir_all(&project_build))
                    .map_err(|_| {
                        "native-capability-project-comparison-workspace-failure".to_owned()
                    })?;
                let project_build_result = run_native_command(
                    &binary,
                    &empty_path,
                    &workdir,
                    &[
                        "project-build".to_owned(),
                        project_path.to_string_lossy().into_owned(),
                        project_cache.to_string_lossy().into_owned(),
                        project_build.to_string_lossy().into_owned(),
                        profile_digest.to_owned(),
                        toolchain_digest.to_owned(),
                    ],
                    &mut process_count,
                )?;
                require_project_stage("project-build", &project_build_result)?;
                let project_translation = run_native_command(
                    &binary,
                    &empty_path,
                    &workdir,
                    &[
                        "project-translate".to_owned(),
                        project_path.to_string_lossy().into_owned(),
                        project_cache.to_string_lossy().into_owned(),
                        project_build.to_string_lossy().into_owned(),
                        profile_digest.to_owned(),
                        toolchain_digest.to_owned(),
                        workload.module.clone(),
                    ],
                    &mut process_count,
                )?;
                require_project_stage("project-translate", &project_translation)?;
                let project_run = run_native_command(
                    &binary,
                    &empty_path,
                    &workdir,
                    &[
                        "project-run-sandbox".to_owned(),
                        project_path.to_string_lossy().into_owned(),
                        project_cache.to_string_lossy().into_owned(),
                        project_build.to_string_lossy().into_owned(),
                        profile_digest.to_owned(),
                        toolchain_digest.to_owned(),
                        workload.module.clone(),
                        workload.input_digest.clone(),
                        project_sandbox.to_string_lossy().into_owned(),
                    ],
                    &mut process_count,
                )?;
                require_project_stage("project-run-sandbox", &project_run)?;

                let direct_facts = parse_capability_execution_facts(&direct.stdout)?;
                let bundle_facts = parse_capability_execution_facts(&bundled.stdout)?;
                let translation_facts =
                    parse_project_translation_facts(&project_translation.stdout)?;
                let (project_run_facts, project_stdout_digest) =
                    parse_project_run_observation(&project_run.stdout)?;
                let build_digest = parse_project_build_result(&project_build_result.stdout)?;
                let direct_files = snapshot_capability_files(&direct_root, &["source.re"])?;
                let bundle_files = snapshot_capability_files(&bundle_root, &[])?;
                let project_files = snapshot_capability_files(&project_sandbox, &[])?;
                let direct_sandbox_digest =
                    capability_sandbox_digest(&direct_files).map_err(|error| error.code)?;
                let bundle_sandbox_digest =
                    capability_sandbox_digest(&bundle_files).map_err(|error| error.code)?;
                let project_sandbox_digest =
                    capability_sandbox_digest(&project_files).map_err(|error| error.code)?;
                macro_rules! mismatch {
                    ($condition:expr, $code:literal) => {
                        if $condition {
                            return Err($code.to_owned());
                        }
                    };
                }
                mismatch!(
                    direct.stdout != bundled.stdout,
                    "native-capability-project-comparison-result-mismatch"
                );
                mismatch!(
                    direct_files != workload.sandbox_after,
                    "native-capability-project-comparison-direct-effect-mismatch"
                );
                mismatch!(
                    bundle_files != workload.sandbox_after,
                    "native-capability-project-comparison-bundle-effect-mismatch"
                );
                mismatch!(
                    project_files != workload.sandbox_after,
                    "native-capability-project-comparison-project-effect-mismatch"
                );
                mismatch!(
                    direct_facts.graph_revision != project_run_facts.graph_revision,
                    "native-capability-project-comparison-graph-mismatch"
                );
                mismatch!(
                    direct_facts.input_digest != workload.input_digest,
                    "native-capability-project-comparison-direct-input-mismatch"
                );
                mismatch!(
                    bundle_facts.input_digest != workload.input_digest,
                    "native-capability-project-comparison-bundle-input-mismatch"
                );
                mismatch!(
                    project_run_facts.input_digest != workload.input_digest,
                    "native-capability-project-comparison-project-input-mismatch"
                );
                mismatch!(
                    direct_facts.artifact_digest != bundle_facts.artifact_digest,
                    "native-capability-project-comparison-bundle-artifact-mismatch"
                );
                mismatch!(
                    direct_facts.artifact_digest != project_run_facts.artifact_digest,
                    "native-capability-project-comparison-project-artifact-mismatch"
                );
                mismatch!(
                    direct_facts.receipt_digest != bundle_facts.receipt_digest,
                    "native-capability-project-comparison-bundle-receipt-mismatch"
                );
                mismatch!(
                    direct_facts.receipt_digest != project_run_facts.vm_receipt_digest,
                    "native-capability-project-comparison-project-receipt-mismatch"
                );
                mismatch!(
                    direct_facts.outcome_code != bundle_facts.outcome_code,
                    "native-capability-project-comparison-bundle-outcome-mismatch"
                );
                mismatch!(
                    direct_facts.outcome_code != project_run_facts.outcome_code,
                    "native-capability-project-comparison-project-outcome-mismatch"
                );
                mismatch!(
                    direct_facts.outcome_type != bundle_facts.outcome_type,
                    "native-capability-project-comparison-bundle-outcome-type-mismatch"
                );
                mismatch!(
                    direct_facts.outcome_type != project_run_facts.outcome_type,
                    "native-capability-project-comparison-project-outcome-type-mismatch"
                );
                mismatch!(
                    direct_facts.program_stdout_digest != project_stdout_digest,
                    "native-capability-project-comparison-project-stdout-mismatch"
                );
                mismatch!(
                    translation_facts.artifact_digest != direct_facts.artifact_digest,
                    "native-capability-project-comparison-translation-artifact-mismatch"
                );
                mismatch!(
                    translation_facts.graph_revision != direct_facts.graph_revision,
                    "native-capability-project-comparison-translation-graph-mismatch"
                );
                mismatch!(
                    translation_facts.module != workload.module,
                    "native-capability-project-comparison-translation-module-mismatch"
                );
                mismatch!(
                    translation_facts.build_key != project_run_facts.build_key,
                    "native-capability-project-comparison-build-key-mismatch"
                );
                mismatch!(
                    translation_facts.build_manifest_digest
                        != project_run_facts.build_manifest_digest,
                    "native-capability-project-comparison-build-manifest-mismatch"
                );
                mismatch!(
                    translation_facts.module_artifact_digest
                        != project_run_facts.module_artifact_digest,
                    "native-capability-project-comparison-module-artifact-mismatch"
                );
                mismatch!(
                    translation_facts.module_cache_key != project_run_facts.module_cache_key,
                    "native-capability-project-comparison-module-cache-mismatch"
                );
                mismatch!(
                    translation_facts.profile != NATIVE_BYTECODE_PROFILE,
                    "native-capability-project-comparison-profile-mismatch"
                );
                mismatch!(
                    project_run_facts.profile != NATIVE_BYTECODE_PROFILE,
                    "native-capability-project-comparison-project-profile-mismatch"
                );
                mismatch!(
                    translation_facts.translation_digest != project_run_facts.translation_digest,
                    "native-capability-project-comparison-translation-mismatch"
                );
                mismatch!(
                    project_run_facts.module != workload.module,
                    "native-capability-project-comparison-project-module-mismatch"
                );
                mismatch!(
                    project_run_facts.project_digest != project.project_digest,
                    "native-capability-project-comparison-project-digest-mismatch"
                );
                mismatch!(
                    project_run_facts.project_graph_revision != project.graph_revision,
                    "native-capability-project-comparison-project-graph-mismatch"
                );
                mismatch!(
                    project_run_facts.profile_digest != profile_digest,
                    "native-capability-project-comparison-project-profile-digest-mismatch"
                );
                mismatch!(
                    project_run_facts.toolchain_digest != toolchain_digest,
                    "native-capability-project-comparison-project-toolchain-mismatch"
                );
                mismatch!(
                    project_run_facts.outcome_code != workload.expected_outcome_code,
                    "native-capability-project-comparison-project-expected-outcome-mismatch"
                );
                mismatch!(
                    direct_facts.outcome_code != workload.expected_outcome_code,
                    "native-capability-project-comparison-direct-expected-outcome-mismatch"
                );
                mismatch!(
                    bundle_facts.outcome_code != workload.expected_outcome_code,
                    "native-capability-project-comparison-bundle-expected-outcome-mismatch"
                );
                observations.push(CapabilityProjectComparisonObservation {
                    workload_id: workload.workload_id.clone(),
                    module: workload.module.clone(),
                    module_path: workload.module_path.clone(),
                    source_sha256: workload.source_sha256.clone(),
                    project_digest: project_run_facts.project_digest,
                    project_graph_revision: project_run_facts.project_graph_revision,
                    graph_revision: direct_facts.graph_revision,
                    project_build_digest: build_digest,
                    project_translation_digest: digest_bytes(&project_translation.stdout),
                    project_run_digest: digest_bytes(&project_run.stdout),
                    project_artifact_digest: project_run_facts.artifact_digest,
                    project_receipt_digest: project_run_facts.vm_receipt_digest,
                    project_stdout_digest,
                    project_sandbox_digest,
                    direct_artifact_digest: direct_facts.artifact_digest,
                    bundle_artifact_digest: bundle_facts.artifact_digest,
                    direct_result_digest: digest_bytes(&direct.stdout),
                    bundle_result_digest: digest_bytes(&bundled.stdout),
                    direct_receipt_digest: direct_facts.receipt_digest,
                    bundle_receipt_digest: bundle_facts.receipt_digest,
                    direct_stdout_digest: direct_facts.program_stdout_digest,
                    bundle_stdout_digest: bundle_facts.program_stdout_digest,
                    direct_sandbox_digest,
                    bundle_sandbox_digest,
                    input_digest: workload.input_digest.clone(),
                    project_outcome_code: project_run_facts.outcome_code,
                    direct_outcome_code: direct_facts.outcome_code,
                    bundle_outcome_code: bundle_facts.outcome_code,
                    status: "matched".to_owned(),
                });
            }
            build_capability_project_comparison_report(&catalog, observations)
                .map_err(|error| error.code)
                .and_then(|report| {
                    serialize_capability_project_comparison_report(&catalog, &report)
                        .map_err(|error| error.code)
                })
        })();
        fs::remove_dir_all(&root).ok();
        comparison
    })();
    match result {
        Ok(report) => {
            if write_atomic(&output_path, report.as_bytes()).is_err() {
                eprintln!("native-capability-project-comparison-report-write-failure");
                return Err(74);
            }
            print!("{report}");
            Ok(())
        }
        Err(code) => {
            eprintln!(
                "{{\"diagnostics\":[{{\"code\":{}}}],\"ok\":false,\"schema\":{}}}",
                quote(&code),
                quote("re.native-capability-project-comparison-report@0.1.0")
            );
            Err(65)
        }
    }
}

fn validate_project_capability_authority(
    project: &revia_core::project::NativeProject,
    project_path: &Path,
    catalog: &CapabilityProjectComparisonCatalog,
) -> Result<(), String> {
    for workload in &catalog.workloads {
        let module = project
            .modules
            .iter()
            .find(|module| module.name == workload.module)
            .ok_or_else(|| "native-capability-project-comparison-module-missing".to_owned())?;
        let package_module = project
            .package_manifest
            .modules
            .iter()
            .find(|candidate| candidate.name == workload.module)
            .ok_or_else(|| "native-capability-project-comparison-module-missing".to_owned())?;
        let entry = package_module
            .interface
            .exports
            .iter()
            .find(|export| export.kind == "function" && export.name == "main")
            .ok_or_else(|| "native-capability-project-comparison-contract-missing".to_owned())?;
        if entry.contract_digest != native_project_capability_contract_digest(&workload.module) {
            return Err("native-capability-project-comparison-contract-digest-mismatch".to_owned());
        }
        if module.path != workload.module_path || module.source_sha256 != workload.source_sha256 {
            return Err("native-capability-project-comparison-project-module-drift".to_owned());
        }
        let source = fs::read_to_string(project_path.join(&module.path)).map_err(|_| {
            "native-capability-project-comparison-project-source-unreadable".to_owned()
        })?;
        if source != workload.source {
            return Err("native-capability-project-comparison-project-source-drift".to_owned());
        }
        if workload
            .sandbox_before
            .iter()
            .chain(&workload.sandbox_after)
            .any(|file| file.path == "project.json" || file.path == workload.module_path)
        {
            return Err("native-capability-project-comparison-sandbox-overlaps-project".to_owned());
        }
    }
    Ok(())
}

fn require_project_stage(command: &str, result: &NativeCommandResult) -> Result<(), String> {
    if result.exit_code != 0 || !result.stderr.is_empty() {
        return Err(format!(
            "native-capability-project-comparison-{command}-failed"
        ));
    }
    Ok(())
}

fn parse_project_build_result(source: &[u8]) -> Result<String, String> {
    let entries = parse_exact_json_object(
        source,
        &[
            "built",
            "hits",
            "invalidation",
            "manifest",
            "misses",
            "ok",
            "published",
            "schema",
        ],
        "native-capability-project-comparison-project-build-invalid",
    )?;
    if required_json_string(&entries, "schema")? != "re.native-project-build-result@0.1.0"
        || !matches!(
            entries.iter().find(|(key, _)| key == "ok"),
            Some((_, JsonValue::Bool(true)))
        )
    {
        return Err("native-capability-project-comparison-project-build-invalid".to_owned());
    }
    Ok(digest_bytes(source))
}

struct CapabilityExecutionFacts {
    artifact_digest: String,
    graph_revision: String,
    input_digest: String,
    program_stdout_digest: String,
    result_digest: String,
    receipt_digest: String,
    outcome_type: String,
    outcome_code: u8,
}

fn parse_capability_execution_facts(source: &[u8]) -> Result<CapabilityExecutionFacts, String> {
    let entries = parse_exact_json_object(
        source,
        &[
            "artifact_digest",
            "executor",
            "graph_revision",
            "host_profile",
            "input_digest",
            "invocations",
            "ok",
            "outcome",
            "profile",
            "program_stdout",
            "receipt_digest",
            "schema",
            "trace",
        ],
        "native-capability-comparison-runtime-result-invalid",
    )?;
    let outcome = entries
        .iter()
        .find(|(key, _)| key == "outcome")
        .and_then(|(_, value)| match value {
            JsonValue::Object(value) => Some(value),
            _ => None,
        })
        .ok_or_else(|| "native-capability-comparison-runtime-result-invalid".to_owned())?;
    if required_json_string(&entries, "schema")? != "re.native-host-execution-result@0.1.0"
        || !matches!(
            entries.iter().find(|(key, _)| key == "ok"),
            Some((_, JsonValue::Bool(true)))
        )
    {
        return Err("native-capability-comparison-runtime-result-invalid".to_owned());
    }
    let program_stdout = required_json_string(&entries, "program_stdout")?;
    let outcome_type = required_json_string(outcome, "type")?;
    Ok(CapabilityExecutionFacts {
        artifact_digest: required_json_string(&entries, "artifact_digest")?,
        graph_revision: required_json_string(&entries, "graph_revision")?,
        input_digest: required_json_string(&entries, "input_digest")?,
        program_stdout_digest: digest_bytes(program_stdout.as_bytes()),
        result_digest: digest_bytes(source),
        receipt_digest: required_json_string(&entries, "receipt_digest")?,
        outcome_type,
        outcome_code: required_json_u8(outcome, "code")?,
    })
}

fn materialize_capability_files(
    root: &Path,
    files: &[CapabilitySandboxFile],
) -> Result<(), String> {
    for file in files {
        let path = root.join(&file.path);
        let parent = path
            .parent()
            .ok_or_else(|| "native-capability-comparison-sandbox-invalid".to_owned())?;
        fs::create_dir_all(parent)
            .map_err(|_| "native-capability-comparison-sandbox-write-failure".to_owned())?;
        let bytes = decode_capability_hex(&file.bytes_hex)?;
        fs::write(path, bytes)
            .map_err(|_| "native-capability-comparison-sandbox-write-failure".to_owned())?;
    }
    Ok(())
}

fn snapshot_capability_files(
    root: &Path,
    ignored: &[&str],
) -> Result<Vec<CapabilitySandboxFile>, String> {
    let mut files = Vec::new();
    snapshot_capability_files_inner(root, root, ignored, &mut files)?;
    files.sort_by(|left, right| left.path.as_bytes().cmp(right.path.as_bytes()));
    Ok(files)
}

fn snapshot_capability_files_inner(
    root: &Path,
    current: &Path,
    ignored: &[&str],
    files: &mut Vec<CapabilitySandboxFile>,
) -> Result<(), String> {
    let mut entries = fs::read_dir(current)
        .map_err(|_| "native-capability-comparison-sandbox-read-failure".to_owned())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "native-capability-comparison-sandbox-read-failure".to_owned())?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|_| "native-capability-comparison-sandbox-read-failure".to_owned())?;
        if metadata.file_type().is_symlink() {
            return Err("native-capability-comparison-sandbox-symlink".to_owned());
        }
        if metadata.is_dir() {
            snapshot_capability_files_inner(root, &path, ignored, files)?;
            continue;
        }
        if !metadata.is_file() {
            return Err("native-capability-comparison-sandbox-entry-invalid".to_owned());
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|_| "native-capability-comparison-sandbox-path-invalid".to_owned())?
            .to_string_lossy()
            .replace('\\', "/");
        if ignored.iter().any(|name| *name == relative) {
            continue;
        }
        let bytes = fs::read(&path)
            .map_err(|_| "native-capability-comparison-sandbox-read-failure".to_owned())?;
        files.push(CapabilitySandboxFile::new(relative, &bytes));
    }
    Ok(())
}

fn decode_capability_hex(value: &str) -> Result<Vec<u8>, String> {
    let hex = value
        .strip_prefix("hex:")
        .ok_or_else(|| "native-capability-comparison-sandbox-invalid".to_owned())?;
    let (pairs, remainder) = hex.as_bytes().as_chunks::<2>();
    debug_assert!(remainder.is_empty());
    pairs
        .iter()
        .map(|pair| {
            let text = std::str::from_utf8(pair)
                .map_err(|_| "native-capability-comparison-sandbox-invalid".to_owned())?;
            u8::from_str_radix(text, 16)
                .map_err(|_| "native-capability-comparison-sandbox-invalid".to_owned())
        })
        .collect()
}

fn bundle_comparison(catalog_path: &str, project_path: &str, output_path: &str) -> Result<(), i32> {
    let output_path = absolute_input_path(Path::new(output_path)).map_err(|_| 66)?;
    let result = (|| -> Result<String, String> {
        let catalog_path = absolute_input_path(Path::new(catalog_path))?;
        let project_path = absolute_input_path(Path::new(project_path))?;
        if path_is_within(&project_path, &output_path) {
            return Err("native-runtime-bundle-comparison-report-inside-project".to_owned());
        }
        let catalog_source = fs::read_to_string(&catalog_path)
            .map_err(|_| "native-runtime-bundle-comparison-catalog-unreadable".to_owned())?;
        let catalog = parse_comparison_catalog(&catalog_source).map_err(|error| error.code)?;
        let project = load_project_directory(&project_path).map_err(|error| error.code)?;
        let binary = env::current_exe()
            .map_err(|_| "native-runtime-bundle-comparison-binary-unreadable".to_owned())?;
        let root = native_temp_root("bundle-comparison");
        let empty_path = root.join("empty-path");
        fs::create_dir_all(&empty_path)
            .map_err(|_| "native-runtime-bundle-comparison-workspace-failure".to_owned())?;
        let comparison = (|| -> Result<String, String> {
            let mut process_count = 0;
            let mut observations = Vec::with_capacity(catalog.workloads.len());
            let mut kinds = BTreeSet::new();
            for (index, workload) in catalog.workloads.iter().enumerate() {
                kinds.insert(workload.kind.clone());
                let source = if workload.kind == "project-workflow" {
                    let module_name = workload
                        .project_module
                        .as_deref()
                        .ok_or_else(|| "comparison-catalog-project-authority-invalid".to_owned())?;
                    if workload.project_digest.as_deref() != Some(project.project_digest.as_str()) {
                        return Err(
                            "native-runtime-bundle-comparison-project-digest-mismatch".to_owned()
                        );
                    }
                    let module = project
                        .modules
                        .iter()
                        .find(|module| module.name == module_name)
                        .ok_or_else(|| {
                            "native-runtime-bundle-comparison-project-module-missing".to_owned()
                        })?;
                    let bytes = fs::read(project_path.join(&module.path)).map_err(|_| {
                        "native-runtime-bundle-comparison-project-source-unreadable".to_owned()
                    })?;
                    let source = SourceText::from_bytes(&bytes, &module.path)
                        .map_err(|error| error.code.to_owned())?;
                    let graph = if source.text.starts_with("re 0.1 canonical\n") {
                        load_canonical_graph(&source.text)
                    } else {
                        parse_compact_graph(&source.text, &module.path).and_then(check_graph)
                    }
                    .map_err(|error| error.code)?;
                    let canonical =
                        serialize_canonical_graph(&graph).map_err(|error| error.code)?;
                    if canonical != workload.source {
                        return Err(
                            "native-runtime-bundle-comparison-project-source-mismatch".to_owned()
                        );
                    }
                    canonical
                } else {
                    workload.source.clone()
                };
                let graph = load_canonical_graph(&source)
                    .map_err(|_| "native-runtime-bundle-comparison-source-invalid".to_owned())?;
                let revision = graph_revision(&graph).map_err(|error| error.code)?;
                let workdir = root.join(format!("work-{index}"));
                fs::create_dir_all(&workdir)
                    .map_err(|_| "native-runtime-bundle-comparison-workspace-failure".to_owned())?;
                let source_path = workdir.join("source.re");
                let bundle_path = workdir.join("runtime.rebundle");
                let sandbox_path = workdir.join("sandbox");
                fs::create_dir(&sandbox_path)
                    .map_err(|_| "native-runtime-bundle-comparison-workspace-failure".to_owned())?;
                fs::write(&source_path, source.as_bytes()).map_err(|_| {
                    "native-runtime-bundle-comparison-source-write-failure".to_owned()
                })?;
                let packaged = run_native_command(
                    &binary,
                    &empty_path,
                    &workdir,
                    &[
                        "runtime-package".to_owned(),
                        source_path.to_string_lossy().into_owned(),
                        bundle_path.to_string_lossy().into_owned(),
                    ],
                    &mut process_count,
                )?;
                require_success("runtime-package", &packaged)?;
                let bundle_source = fs::read_to_string(&bundle_path)
                    .map_err(|_| "native-runtime-bundle-comparison-bundle-unreadable".to_owned())?;
                let bundle = verify_runtime_bundle(&bundle_source).map_err(|error| error.code)?;
                let bundle_artifact =
                    load_bytecode_artifact(&bundle.artifact).map_err(|error| error.code)?;
                let bundle_execution_artifact_digest = bundle_artifact.artifact_digest;
                if bundle.graph_revision != revision {
                    return Err(
                        "native-runtime-bundle-comparison-graph-revision-mismatch".to_owned()
                    );
                }
                if workload.kind == "project-workflow" {
                    let module_name = workload
                        .project_module
                        .as_deref()
                        .ok_or_else(|| "comparison-catalog-project-authority-invalid".to_owned())?;
                    let project_workspace = workdir.join("project");
                    let project_cache = project_workspace.join("cache");
                    let project_build = project_workspace.join("build");
                    fs::create_dir_all(&project_cache).map_err(|_| {
                        "native-runtime-bundle-comparison-workspace-failure".to_owned()
                    })?;
                    fs::create_dir_all(&project_build).map_err(|_| {
                        "native-runtime-bundle-comparison-workspace-failure".to_owned()
                    })?;
                    let project_build_result = run_native_command(
                        &binary,
                        &empty_path,
                        &project_workspace,
                        &[
                            "project-build".to_owned(),
                            project_path.to_string_lossy().into_owned(),
                            project_cache.to_string_lossy().into_owned(),
                            project_build.to_string_lossy().into_owned(),
                            PROJECT_INIT_PROFILE_DIGEST.to_owned(),
                            PROJECT_INIT_TOOLCHAIN_DIGEST.to_owned(),
                        ],
                        &mut process_count,
                    )?;
                    require_success("project-build", &project_build_result)?;
                    let project_translate_result = run_native_command(
                        &binary,
                        &empty_path,
                        &project_workspace,
                        &[
                            "project-translate".to_owned(),
                            project_path.to_string_lossy().into_owned(),
                            project_cache.to_string_lossy().into_owned(),
                            project_build.to_string_lossy().into_owned(),
                            PROJECT_INIT_PROFILE_DIGEST.to_owned(),
                            PROJECT_INIT_TOOLCHAIN_DIGEST.to_owned(),
                            module_name.to_owned(),
                        ],
                        &mut process_count,
                    )?;
                    require_success("project-translate", &project_translate_result)?;
                    let translation =
                        parse_project_translation_facts(&project_translate_result.stdout)?;
                    let project_run_result = run_native_command(
                        &binary,
                        &empty_path,
                        &project_workspace,
                        &[
                            "project-run".to_owned(),
                            project_path.to_string_lossy().into_owned(),
                            project_cache.to_string_lossy().into_owned(),
                            project_build.to_string_lossy().into_owned(),
                            PROJECT_INIT_PROFILE_DIGEST.to_owned(),
                            PROJECT_INIT_TOOLCHAIN_DIGEST.to_owned(),
                            module_name.to_owned(),
                            workload.input_digest.clone(),
                        ],
                        &mut process_count,
                    )?;
                    require_success("project-run", &project_run_result)?;
                    let project_run = parse_project_run_authority(&project_run_result.stdout)?;
                    if project_run.project_digest != project.project_digest
                        || project_run.module != module_name
                        || project_run.graph_revision != bundle.graph_revision
                        || project_run.input_digest != workload.input_digest
                        || project_run.artifact_digest != bundle_execution_artifact_digest
                        || project_run.project_graph_revision != project.graph_revision
                        || project_run.profile_digest != PROJECT_INIT_PROFILE_DIGEST
                        || project_run.toolchain_digest != PROJECT_INIT_TOOLCHAIN_DIGEST
                        || project_run.artifact_digest != translation.artifact_digest
                        || project_run.graph_revision != translation.graph_revision
                        || project_run.module != translation.module
                        || project_run.build_key != translation.build_key
                        || project_run.build_manifest_digest != translation.build_manifest_digest
                        || project_run.module_cache_key != translation.module_cache_key
                        || project_run.module_artifact_digest != translation.module_artifact_digest
                        || project_run.translation_digest != translation.translation_digest
                        || project_run.profile != translation.profile
                    {
                        return Err(
                            "native-runtime-bundle-comparison-project-run-authority-mismatch"
                                .to_owned(),
                        );
                    }
                    let bundled = run_native_command(
                        &binary,
                        &empty_path,
                        &workdir,
                        &[
                            "runtime-run".to_owned(),
                            bundle_path.to_string_lossy().into_owned(),
                            workload.input_digest.clone(),
                            sandbox_path.to_string_lossy().into_owned(),
                        ],
                        &mut process_count,
                    )?;
                    require_success("runtime-run", &bundled)?;
                    let runtime = parse_runtime_run_facts(&bundled.stdout)?;
                    if runtime.graph_revision != project_run.graph_revision
                        || runtime.artifact_digest != project_run.artifact_digest
                        || runtime.input_digest != project_run.input_digest
                        || runtime.outcome_code != project_run.outcome_code
                        || runtime.outcome_type != project_run.outcome_type
                        || runtime.receipt_digest != project_run.vm_receipt_digest
                    {
                        return Err(
                            "native-runtime-bundle-comparison-project-run-result-mismatch"
                                .to_owned(),
                        );
                    }
                    observations.push(BundleComparisonObservation::project_executed(
                        workload.workload_id.clone(),
                        workload.kind.clone(),
                        revision,
                        workload.input_digest.clone(),
                        bundle.bundle_digest,
                        bundle.source_digest,
                        bundle_execution_artifact_digest,
                        runtime.receipt_digest.clone(),
                        ProjectRunAuthority {
                            artifact_digest: project_run.artifact_digest,
                            project_digest: project_run.project_digest,
                            module: project_run.module,
                            graph_revision: project_run.graph_revision,
                            input_digest: project_run.input_digest,
                            build_key: project_run.build_key,
                            build_manifest_digest: project_run.build_manifest_digest,
                            module_cache_key: project_run.module_cache_key,
                            module_artifact_digest: project_run.module_artifact_digest,
                            translation_digest: project_run.translation_digest,
                            vm_receipt_digest: project_run.vm_receipt_digest,
                            outcome_code: project_run.outcome_code,
                            outcome_type: project_run.outcome_type,
                            profile: project_run.profile,
                            profile_digest: project_run.profile_digest,
                            project_graph_revision: project_run.project_graph_revision,
                            toolchain_digest: project_run.toolchain_digest,
                            run_digest: project_run.run_digest,
                        },
                    ));
                } else if workload.kind == "success" {
                    let direct = run_native_command(
                        &binary,
                        &empty_path,
                        &workdir,
                        &[
                            "execute".to_owned(),
                            source_path.to_string_lossy().into_owned(),
                            workload.input_digest.clone(),
                        ],
                        &mut process_count,
                    )?;
                    require_success("execute", &direct)?;
                    let bundled = run_native_command(
                        &binary,
                        &empty_path,
                        &workdir,
                        &[
                            "runtime-run".to_owned(),
                            bundle_path.to_string_lossy().into_owned(),
                            workload.input_digest.clone(),
                            sandbox_path.to_string_lossy().into_owned(),
                        ],
                        &mut process_count,
                    )?;
                    require_success("runtime-run", &bundled)?;
                    if direct.stdout != bundled.stdout {
                        return Err("native-runtime-bundle-comparison-result-mismatch".to_owned());
                    }
                    observations.push(BundleComparisonObservation::executed(
                        workload.workload_id.clone(),
                        workload.kind.clone(),
                        revision,
                        workload.input_digest.clone(),
                        bundle.bundle_digest,
                        bundle.source_digest,
                        bundle_execution_artifact_digest,
                        digest_bytes(&direct.stdout),
                    ));
                } else {
                    observations.push(BundleComparisonObservation::verified_only(
                        workload.workload_id.clone(),
                        workload.kind.clone(),
                        revision,
                        workload.input_digest.clone(),
                        bundle.bundle_digest,
                        bundle.source_digest,
                        bundle_execution_artifact_digest,
                    ));
                }
            }
            for required in [
                "success",
                "closed-error",
                "host-boundary",
                "project-workflow",
            ] {
                if !kinds.contains(required) {
                    return Err("native-runtime-bundle-comparison-workload-set-invalid".to_owned());
                }
            }
            let report =
                BundleComparisonReport::new(digest_bytes(catalog_source.as_bytes()), observations);
            serialize_bundle_comparison_report(&report).map_err(|error| error.code)
        })();
        fs::remove_dir_all(&root).ok();
        comparison
    })();
    match result {
        Ok(report) => {
            if write_atomic(&output_path, report.as_bytes()).is_err() {
                eprintln!("native-runtime-bundle-comparison-report-write-failure");
                return Err(74);
            }
            print!("{report}");
            Ok(())
        }
        Err(code) => {
            eprintln!(
                "{{\"diagnostics\":[{{\"code\":{}}}],\"ok\":false,\"schema\":{}}}",
                quote(&code),
                quote(BUNDLE_COMPARISON_SCHEMA)
            );
            Err(65)
        }
    }
}

struct ProjectTranslationFacts {
    artifact_digest: String,
    build_key: String,
    build_manifest_digest: String,
    graph_revision: String,
    module_artifact_digest: String,
    module_cache_key: String,
    module: String,
    profile: String,
    translation_digest: String,
}

struct RuntimeRunFacts {
    artifact_digest: String,
    graph_revision: String,
    input_digest: String,
    outcome_code: u8,
    outcome_type: String,
    receipt_digest: String,
}

fn parse_project_translation_facts(source: &[u8]) -> Result<ProjectTranslationFacts, String> {
    let entries = parse_exact_json_object(
        source,
        &[
            "artifact_digest",
            "artifact_source",
            "build_key",
            "build_manifest_digest",
            "graph_revision",
            "module_artifact_digest",
            "module_cache_key",
            "module",
            "entry",
            "profile",
            "profile_digest",
            "project_graph_revision",
            "project_digest",
            "schema",
            "toolchain_digest",
            "translation_digest",
        ],
        "native-runtime-bundle-comparison-project-translation-invalid",
    )?;
    if required_json_string(&entries, "schema")? != "re.native-project-translation@0.1.0"
        || required_json_string(&entries, "entry")? != "main"
    {
        return Err("native-runtime-bundle-comparison-project-translation-invalid".to_owned());
    }
    Ok(ProjectTranslationFacts {
        artifact_digest: required_json_string(&entries, "artifact_digest")?,
        build_key: required_json_string(&entries, "build_key")?,
        build_manifest_digest: required_json_string(&entries, "build_manifest_digest")?,
        graph_revision: required_json_string(&entries, "graph_revision")?,
        module_artifact_digest: required_json_string(&entries, "module_artifact_digest")?,
        module_cache_key: required_json_string(&entries, "module_cache_key")?,
        module: required_json_string(&entries, "module")?,
        profile: required_json_string(&entries, "profile")?,
        translation_digest: required_json_string(&entries, "translation_digest")?,
    })
}

fn parse_project_run_authority(source: &[u8]) -> Result<ProjectRunAuthority, String> {
    let entries = parse_exact_json_object(
        source,
        &[
            "artifact_digest",
            "build_key",
            "build_manifest_digest",
            "graph_revision",
            "input_digest",
            "module",
            "module_artifact_digest",
            "module_cache_key",
            "outcome_code",
            "outcome_type",
            "profile",
            "profile_digest",
            "project_digest",
            "project_graph_revision",
            "run_digest",
            "schema",
            "toolchain_digest",
            "translation_digest",
            "vm_receipt_digest",
        ],
        "native-runtime-bundle-comparison-project-run-invalid",
    )?;
    let authority = ProjectRunAuthority {
        artifact_digest: required_json_string(&entries, "artifact_digest")?,
        project_digest: required_json_string(&entries, "project_digest")?,
        module: required_json_string(&entries, "module")?,
        graph_revision: required_json_string(&entries, "graph_revision")?,
        input_digest: required_json_string(&entries, "input_digest")?,
        build_key: required_json_string(&entries, "build_key")?,
        build_manifest_digest: required_json_string(&entries, "build_manifest_digest")?,
        module_cache_key: required_json_string(&entries, "module_cache_key")?,
        module_artifact_digest: required_json_string(&entries, "module_artifact_digest")?,
        translation_digest: required_json_string(&entries, "translation_digest")?,
        vm_receipt_digest: required_json_string(&entries, "vm_receipt_digest")?,
        outcome_code: required_json_u8(&entries, "outcome_code")?,
        outcome_type: required_json_string(&entries, "outcome_type")?,
        profile: required_json_string(&entries, "profile")?,
        profile_digest: required_json_string(&entries, "profile_digest")?,
        project_graph_revision: required_json_string(&entries, "project_graph_revision")?,
        toolchain_digest: required_json_string(&entries, "toolchain_digest")?,
        run_digest: required_json_string(&entries, "run_digest")?,
    };
    if required_json_string(&entries, "schema")? != "re.native-project-run@0.1.0" {
        return Err("native-runtime-bundle-comparison-project-run-invalid".to_owned());
    }
    Ok(authority)
}

fn parse_project_run_observation(source: &[u8]) -> Result<(ProjectRunAuthority, String), String> {
    let entries = parse_exact_json_object(
        source,
        &["program_stdout", "run", "schema"],
        "native-capability-project-comparison-project-run-observation-invalid",
    )?;
    if required_json_string(&entries, "schema")? != "re.native-project-run-observation@0.1.0" {
        return Err(
            "native-capability-project-comparison-project-run-observation-invalid".to_owned(),
        );
    }
    let program_stdout = required_json_string(&entries, "program_stdout")?;
    let run = entries
        .iter()
        .find(|(key, _)| key == "run")
        .map(|(_, value)| format!("{}\n", canonicalize(value)))
        .ok_or_else(|| {
            "native-capability-project-comparison-project-run-observation-invalid".to_owned()
        })?;
    let authority = parse_project_run_authority(run.as_bytes())?;
    Ok((authority, digest_bytes(program_stdout.as_bytes())))
}

fn parse_runtime_run_facts(source: &[u8]) -> Result<RuntimeRunFacts, String> {
    let entries = parse_exact_json_object(
        source,
        &[
            "artifact_digest",
            "executor",
            "graph_revision",
            "host_profile",
            "input_digest",
            "invocations",
            "ok",
            "outcome",
            "profile",
            "program_stdout",
            "receipt_digest",
            "schema",
            "trace",
        ],
        "native-runtime-bundle-comparison-runtime-result-invalid",
    )?;
    let outcome = entries
        .iter()
        .find(|(key, _)| key == "outcome")
        .and_then(|(_, value)| match value {
            JsonValue::Object(value) => Some(value),
            _ => None,
        })
        .ok_or_else(|| "native-runtime-bundle-comparison-runtime-result-invalid".to_owned())?;
    let facts = RuntimeRunFacts {
        artifact_digest: required_json_string(&entries, "artifact_digest")?,
        graph_revision: required_json_string(&entries, "graph_revision")?,
        input_digest: required_json_string(&entries, "input_digest")?,
        outcome_code: required_json_u8(outcome, "code")?,
        outcome_type: required_json_string(outcome, "type")?,
        receipt_digest: required_json_string(&entries, "receipt_digest")?,
    };
    if required_json_string(&entries, "schema")? != "re.native-host-execution-result@0.1.0"
        || !matches!(
            entries.iter().find(|(key, _)| key == "ok"),
            Some((_, JsonValue::Bool(true)))
        )
    {
        return Err("native-runtime-bundle-comparison-runtime-result-invalid".to_owned());
    }
    Ok(facts)
}

fn parse_exact_json_object(
    source: &[u8],
    expected: &[&str],
    error_code: &str,
) -> Result<Vec<(String, JsonValue)>, String> {
    let source = std::str::from_utf8(source).map_err(|_| error_code.to_owned())?;
    let value = parse_json(source).map_err(|_| error_code.to_owned())?;
    if format!("{}\n", canonicalize(&value)) != source {
        return Err(error_code.to_owned());
    }
    let JsonValue::Object(entries) = value else {
        return Err(error_code.to_owned());
    };
    let keys = entries
        .iter()
        .map(|(key, _)| key.as_str())
        .collect::<BTreeSet<_>>();
    if entries.len() != expected.len() || expected.iter().any(|key| !keys.contains(key)) {
        return Err(error_code.to_owned());
    }
    Ok(entries)
}

fn required_json_string(entries: &[(String, JsonValue)], name: &str) -> Result<String, String> {
    entries
        .iter()
        .find(|(key, _)| key == name)
        .and_then(|(_, value)| match value {
            JsonValue::String(value) => Some(value.clone()),
            _ => None,
        })
        .ok_or_else(|| "native-runtime-bundle-comparison-authority-invalid".to_owned())
}

fn required_json_u8(entries: &[(String, JsonValue)], name: &str) -> Result<u8, String> {
    entries
        .iter()
        .find(|(key, _)| key == name)
        .and_then(|(_, value)| match value {
            JsonValue::Number(value) => value.parse::<u8>().ok(),
            _ => None,
        })
        .ok_or_else(|| "native-runtime-bundle-comparison-authority-invalid".to_owned())
}

fn conformance_run(
    source_path: &str,
    input_digest: &str,
    transcript_path: &str,
) -> Result<(), i32> {
    let transcript_source = fs::read_to_string(transcript_path).map_err(|_| 66)?;
    let transcript = match parse_native_replay_transcript(&transcript_source) {
        Ok(transcript) => transcript,
        Err(error) => {
            print_conformance_error(&error.code);
            return Err(65);
        }
    };
    let graph = match read_graph_quiet(source_path) {
        Ok(graph) => graph,
        Err(code) => {
            print_conformance_error(&code);
            return Err(65);
        }
    };
    let artifact = match translate_graph(&graph) {
        Ok(artifact) => artifact,
        Err(error) => {
            print_conformance_error(&error.code);
            return Err(65);
        }
    };
    let artifact_source = match serialize_bytecode_artifact(&artifact) {
        Ok(source) => source,
        Err(error) => {
            print_conformance_error(&error.code);
            return Err(65);
        }
    };
    let graph_revision = match graph_revision(&graph) {
        Ok(revision) => revision,
        Err(error) => {
            print_conformance_error(&error.code);
            return Err(65);
        }
    };
    let request = revia_core::vm::VmRequest::new(
        graph_revision,
        artifact.artifact_digest.clone(),
        artifact.profile.clone(),
        input_digest,
    );
    let mut bridge = ReplayBridge::new(transcript);
    let result = execute_bytecode(
        &graph,
        &artifact_source,
        &request,
        &mut bridge,
        VmLimits::default(),
    );
    if let Some(code) = bridge.failure_code() {
        print_conformance_error(code);
        return Err(65);
    }
    let result = match result {
        Ok(result) => result,
        Err(error) => {
            print_conformance_error(&error.code);
            return Err(65);
        }
    };
    if let Err(code) = bridge.finish() {
        print_conformance_error(&code);
        return Err(65);
    }
    print_vm_result(&result);
    Ok(())
}

fn cross_language_matrix(
    source_path: &str,
    input_digest: &str,
    transcript_path: &str,
    node_result_path: &str,
    output_path: &str,
) -> Result<(), i32> {
    let transcript_source = fs::read_to_string(transcript_path).map_err(|_| 66)?;
    let transcript = parse_native_replay_transcript(&transcript_source).map_err(|error| {
        print_cross_language_error(&error.code);
        65
    })?;
    let canonical_transcript =
        serialize_native_replay_transcript(&transcript).map_err(|error| {
            print_cross_language_error(&error.code);
            65
        })?;
    let transcript_digest = format!("sha256:{}", sha256_hex(canonical_transcript.as_bytes()));
    let graph = read_graph_quiet(source_path).map_err(|code| {
        print_cross_language_error(&code);
        65
    })?;
    let artifact = translate_graph(&graph).map_err(|error| {
        print_cross_language_error(&error.code);
        65
    })?;
    let artifact_source = serialize_bytecode_artifact(&artifact).map_err(|error| {
        print_cross_language_error(&error.code);
        65
    })?;
    let revision = graph_revision(&graph).map_err(|error| {
        print_cross_language_error(&error.code);
        65
    })?;
    let request = revia_core::vm::VmRequest::new(
        revision.clone(),
        artifact.artifact_digest.clone(),
        artifact.profile.clone(),
        input_digest,
    );
    let mut bridge = ReplayBridge::new(transcript);
    let execution = execute_bytecode(
        &graph,
        &artifact_source,
        &request,
        &mut bridge,
        VmLimits::default(),
    )
    .map_err(|error| {
        print_cross_language_error(&error.code);
        65
    })?;
    if let Some(code) = bridge.failure_code() {
        print_cross_language_error(code);
        return Err(65);
    }
    bridge.finish().map_err(|code| {
        print_cross_language_error(&code);
        65
    })?;
    let native = CrossLanguageBackendResult::measured(
        "native",
        revision.clone(),
        input_digest,
        transcript_digest.clone(),
        format!("sha256:{}", sha256_hex(b"re.native-rust-toolchain@0.1.0")),
        "",
        execution.receipt.receipt_digest.clone(),
        execution.outcome.code as u16,
        execution.outcome.type_name.clone(),
        execution
            .invocations
            .iter()
            .map(|invocation| {
                CrossLanguageInvocation::new(
                    invocation.instance.clone(),
                    invocation.member.clone(),
                    invocation.invocation_id.clone(),
                    invocation.outcome.clone(),
                )
            })
            .collect(),
        "",
    );
    let node_source = fs::read_to_string(node_result_path).map_err(|_| 66)?;
    let node = parse_backend_result(&node_source).map_err(|error| {
        print_cross_language_error(&error.code);
        65
    })?;
    let matrix = build_cross_language_matrix(
        "native-replay",
        revision,
        input_digest,
        transcript_digest,
        vec![native, node],
        vec![
            PendingBackend::new("go", "not-measured"),
            PendingBackend::new("jvm", "not-measured"),
        ],
    )
    .map_err(|error| {
        print_cross_language_error(&error.code);
        65
    })?;
    let output = serialize_cross_language_matrix(&matrix).map_err(|error| {
        print_cross_language_error(&error.code);
        65
    })?;
    write_atomic(Path::new(output_path), output.as_bytes()).map_err(|_| {
        print_cross_language_error("cross-language-matrix-write-failure");
        74
    })?;
    print!("{output}");
    Ok(())
}

fn replay_catalog(catalog_path: &str, output_path: &str) -> Result<(), i32> {
    let catalog_source = fs::read_to_string(catalog_path).map_err(|_| 66)?;
    let catalog = parse_replay_workload_catalog(&catalog_source).map_err(|error| {
        print_replay_catalog_error(&error.code);
        65
    })?;
    let mut observations = Vec::with_capacity(catalog.workloads.len());
    for workload in &catalog.workloads {
        let graph = read_graph_source_quiet(
            workload.source.as_bytes(),
            &format!("catalog:{}", workload.workload_id),
        )
        .map_err(|code| {
            print_replay_catalog_error(&code);
            65
        })?;
        let artifact = translate_graph(&graph).map_err(|error| {
            print_replay_catalog_error(&error.code);
            65
        })?;
        let artifact_source = serialize_bytecode_artifact(&artifact).map_err(|error| {
            print_replay_catalog_error(&error.code);
            65
        })?;
        let revision = graph_revision(&graph).map_err(|error| {
            print_replay_catalog_error(&error.code);
            65
        })?;
        let transcript = parse_native_replay_transcript(&workload.transcript).map_err(|error| {
            print_replay_catalog_error(&error.code);
            65
        })?;
        let transcript_source =
            serialize_native_replay_transcript(&transcript).map_err(|error| {
                print_replay_catalog_error(&error.code);
                65
            })?;
        let transcript_digest = format!("sha256:{}", sha256_hex(transcript_source.as_bytes()));
        let request = revia_core::vm::VmRequest::new(
            revision.clone(),
            artifact.artifact_digest.clone(),
            artifact.profile.clone(),
            &workload.input_digest,
        );
        let mut bridge = ReplayBridge::new(transcript);
        let execution_result = execute_bytecode(
            &graph,
            &artifact_source,
            &request,
            &mut bridge,
            VmLimits::default(),
        );
        if let Some(code) = bridge.failure_code() {
            print_replay_catalog_error(code);
            return Err(65);
        }
        let execution = execution_result.map_err(|error| {
            print_replay_catalog_error(&error.code);
            65
        })?;
        bridge.finish().map_err(|code| {
            print_replay_catalog_error(&code);
            65
        })?;
        let native = CrossLanguageBackendResult::measured(
            "native",
            revision.clone(),
            workload.input_digest.clone(),
            transcript_digest.clone(),
            format!("sha256:{}", sha256_hex(b"re.native-rust-toolchain@0.1.0")),
            "",
            execution.receipt.receipt_digest.clone(),
            execution.outcome.code as u16,
            execution.outcome.type_name.clone(),
            execution
                .invocations
                .iter()
                .map(|invocation| {
                    CrossLanguageInvocation::new(
                        invocation.instance.clone(),
                        invocation.member.clone(),
                        invocation.invocation_id.clone(),
                        invocation.outcome.clone(),
                    )
                })
                .collect(),
            "",
        );
        let (matrix, pending) = match workload.node_result.clone() {
            Some(node) => {
                let matrix = build_cross_language_matrix(
                    workload.workload_id.clone(),
                    revision.clone(),
                    workload.input_digest.clone(),
                    transcript_digest.clone(),
                    vec![native.clone(), node],
                    vec![
                        PendingBackend::new("go", "not-measured"),
                        PendingBackend::new("jvm", "not-measured"),
                    ],
                )
                .map_err(|error| {
                    print_replay_catalog_error(&error.code);
                    65
                })?;
                (
                    Some(matrix),
                    vec![
                        PendingBackend::new("go", "not-measured"),
                        PendingBackend::new("jvm", "not-measured"),
                    ],
                )
            }
            None => (
                None,
                vec![
                    PendingBackend::new("node", "not-supplied"),
                    PendingBackend::new("go", "not-measured"),
                    PendingBackend::new("jvm", "not-measured"),
                ],
            ),
        };
        observations.push(ReplayWorkloadObservation::new(
            workload.workload_id.clone(),
            revision,
            workload.input_digest.clone(),
            transcript_digest,
            native,
            matrix,
            pending,
        ));
    }
    let report = build_replay_workload_report(&catalog, observations).map_err(|error| {
        print_replay_catalog_error(&error.code);
        65
    })?;
    let output = serialize_replay_workload_report(&report).map_err(|error| {
        print_replay_catalog_error(&error.code);
        65
    })?;
    write_atomic(Path::new(output_path), output.as_bytes()).map_err(|_| {
        print_replay_catalog_error("replay-workload-report-write-failure");
        74
    })?;
    print!("{output}");
    Ok(())
}

fn comparison_catalog(
    catalog_path: &str,
    project_path: &str,
    output_path: &str,
) -> Result<(), i32> {
    let result = run_comparison_catalog_report(catalog_path, project_path).and_then(|report| {
        let output = serialize_comparison_report(&report).map_err(|error| error.code)?;
        write_atomic(Path::new(output_path), output.as_bytes())
            .map_err(|_| "comparison-catalog-report-write-failure".to_owned())?;
        Ok(output)
    });
    match result {
        Ok(output) => {
            print!("{output}");
            Ok(())
        }
        Err(code) => {
            eprintln!(
                "{{\"diagnostics\":[{{\"code\":{}}}],\"ok\":false,\"schema\":{}}}",
                quote(&code),
                quote("re.native-comparison-catalog-report@0.1.0")
            );
            Err(65)
        }
    }
}

fn run_comparison_catalog_report(
    catalog_path: &str,
    project_path: &str,
) -> Result<revia_core::comparison_catalog::ComparisonReport, String> {
    let catalog_source =
        fs::read_to_string(catalog_path).map_err(|_| "comparison-catalog-unreadable".to_owned())?;
    let catalog = parse_comparison_catalog(&catalog_source).map_err(|error| error.code)?;
    let project_path = absolute_input_path(Path::new(project_path))?;
    let project = load_project_directory(&project_path).map_err(|error| error.code)?;
    let profile_digest = PROJECT_INIT_PROFILE_DIGEST;
    let toolchain_digest = PROJECT_INIT_TOOLCHAIN_DIGEST;
    let mut observations = Vec::with_capacity(catalog.workloads.len());

    for workload in &catalog.workloads {
        let transcript =
            parse_native_replay_transcript(&workload.transcript).map_err(|error| error.code)?;
        let transcript_source =
            serialize_native_replay_transcript(&transcript).map_err(|error| error.code)?;
        let transcript_digest = format!("sha256:{}", sha256_hex(transcript_source.as_bytes()));
        let observation = if workload.kind == "project-workflow" {
            let module_name = workload
                .project_module
                .as_deref()
                .ok_or_else(|| "comparison-catalog-project-authority-invalid".to_owned())?;
            if workload.project_digest.as_deref() != Some(project.project_digest.as_str()) {
                return Err("comparison-catalog-project-digest-mismatch".to_owned());
            }
            let module = project
                .modules
                .iter()
                .find(|module| module.name == module_name)
                .ok_or_else(|| "comparison-catalog-project-module-missing".to_owned())?;
            let source_path = project_path.join(&module.path);
            let bytes = fs::read(&source_path)
                .map_err(|_| "comparison-catalog-project-source-unreadable".to_owned())?;
            let source = SourceText::from_bytes(&bytes, &module.path)
                .map_err(|error| error.code.to_owned())?;
            let graph = if source.text.starts_with("re 0.1 canonical\n") {
                load_canonical_graph(&source.text)
            } else {
                parse_compact_graph(&source.text, &module.path).and_then(check_graph)
            }
            .map_err(|error| error.code)?;
            let canonical = serialize_canonical_graph(&graph).map_err(|error| error.code)?;
            if canonical != workload.source {
                return Err("comparison-catalog-project-source-mismatch".to_owned());
            }
            let workspace = temporary_project_workspace("comparison-catalog")
                .map_err(|_| "comparison-catalog-workspace-failure".to_owned())?;
            let execution =
                (|| -> Result<revia_core::project_runtime::NativeProjectRun, String> {
                    let translation = translate_project_module(
                        &project_path,
                        workspace.join("cache"),
                        workspace.join("build"),
                        profile_digest,
                        toolchain_digest,
                        module_name,
                    )
                    .map_err(|error| error.code)?;
                    let mut bridge = ReplayBridge::new(transcript);
                    let run = execute_project_module(
                        &project_path,
                        workspace.join("cache"),
                        workspace.join("build"),
                        profile_digest,
                        toolchain_digest,
                        module_name,
                        &translation,
                        &workload.input_digest,
                        &mut bridge,
                        VmLimits::default(),
                    )
                    .map_err(|error| error.code)?;
                    if let Some(code) = bridge.failure_code() {
                        return Err(code.to_owned());
                    }
                    bridge.finish()?;
                    Ok(run)
                })();
            fs::remove_dir_all(&workspace).ok();
            let run = execution?;
            let revision = graph_revision(&graph).map_err(|error| error.code)?;
            ComparisonObservation::new(
                workload,
                revision,
                transcript_digest.clone(),
                backend_result_from_vm("native", &run.vm, &transcript_digest),
                workload.node_result.clone(),
            )
        } else {
            let graph = load_canonical_graph(&workload.source)
                .map_err(|_| "comparison-catalog-source-invalid".to_owned())?;
            let artifact = translate_graph(&graph).map_err(|error| error.code)?;
            let artifact_source =
                serialize_bytecode_artifact(&artifact).map_err(|error| error.code)?;
            let revision = graph_revision(&graph).map_err(|error| error.code)?;
            let request = revia_core::vm::VmRequest::new(
                revision,
                artifact.artifact_digest.clone(),
                artifact.profile.clone(),
                &workload.input_digest,
            );
            let mut bridge = ReplayBridge::new(transcript);
            let execution = execute_bytecode(
                &graph,
                &artifact_source,
                &request,
                &mut bridge,
                VmLimits::default(),
            );
            let revision = graph_revision(&graph).map_err(|error| error.code)?;
            match execution {
                Ok(execution) => {
                    if let Some(code) = bridge.failure_code() {
                        return Err(code.to_owned());
                    }
                    bridge.finish()?;
                    ComparisonObservation::new(
                        workload,
                        revision,
                        transcript_digest.clone(),
                        backend_result_from_vm("native", &execution, &transcript_digest),
                        workload.node_result.clone(),
                    )
                }
                Err(error) if workload.kind == "host-boundary" => {
                    let (_, code) = bridge
                        .observed_failure()
                        .ok_or_else(|| error.code.clone())?;
                    ComparisonObservation::fault(workload, revision, transcript_digest, code)
                }
                Err(error) => return Err(error.code),
            }
        };
        observations.push(observation);
    }
    let report = build_comparison_report(&catalog, observations).map_err(|error| error.code)?;
    Ok(report)
}

fn experiment_kit(catalog_path: &str, project_path: &str, output_path: &str) -> Result<(), i32> {
    let result = run_comparison_catalog_report(catalog_path, project_path).and_then(|report| {
        let catalog_source = fs::read_to_string(catalog_path)
            .map_err(|_| "experiment-kit-catalog-unreadable".to_owned())?;
        let catalog = parse_comparison_catalog(&catalog_source).map_err(|error| error.code)?;
        let kit = build_experiment_kit(
            &catalog,
            &report,
            "darwin-arm64",
            &native_toolchain_digest(),
        )
        .map_err(|error| error.code)?;
        let output = serialize_experiment_kit(&kit).map_err(|error| error.code)?;
        write_atomic(Path::new(output_path), output.as_bytes())
            .map_err(|_| "experiment-kit-write-failure".to_owned())?;
        Ok(output)
    });
    match result {
        Ok(output) => {
            print!("{output}");
            Ok(())
        }
        Err(code) => {
            eprintln!(
                "{{\"diagnostics\":[{{\"code\":{}}}],\"ok\":false,\"schema\":{}}}",
                quote(&code),
                quote("re.cross-language-experiment-kit@0.1.0")
            );
            Err(65)
        }
    }
}

fn backend_result_from_vm(
    backend: &str,
    execution: &revia_core::vm::VmResult,
    transcript_digest: &str,
) -> CrossLanguageBackendResult {
    CrossLanguageBackendResult::measured(
        backend,
        execution.graph_revision.clone(),
        execution.input_digest.clone(),
        transcript_digest,
        native_toolchain_digest(),
        "",
        execution.receipt.receipt_digest.clone(),
        execution.outcome.code as u16,
        execution.outcome.type_name.clone(),
        execution
            .invocations
            .iter()
            .map(|invocation| {
                CrossLanguageInvocation::new(
                    invocation.instance.clone(),
                    invocation.member.clone(),
                    invocation.invocation_id.clone(),
                    invocation.outcome.clone(),
                )
            })
            .collect(),
        "",
    )
}

fn collect_comparison_release_evidence(
    binary: &Path,
    source_path: &Path,
    project_path: &Path,
    module_name: &str,
    empty_path: &Path,
    workspace_root: &Path,
) -> Result<(String, String, String, u32), String> {
    let direct_source = fs::read(source_path)
        .map_err(|_| "native-comparison-catalog-source-unreadable".to_owned())?;
    let direct_graph = read_graph_source_quiet(&direct_source, "comparison-source")?;
    let direct_canonical =
        serialize_canonical_graph(&direct_graph).map_err(|error| error.code.to_owned())?;
    let project = load_project_directory(project_path).map_err(|error| error.code)?;
    let project_module = project
        .modules
        .iter()
        .find(|module| module.name == module_name)
        .ok_or_else(|| "native-comparison-catalog-project-module-missing".to_owned())?;
    let project_source = fs::read(project_path.join(&project_module.path))
        .map_err(|_| "native-comparison-catalog-project-source-unreadable".to_owned())?;
    let project_graph = read_graph_source_quiet(&project_source, "comparison-project-source")?;
    let project_canonical =
        serialize_canonical_graph(&project_graph).map_err(|error| error.code.to_owned())?;
    let catalog_source = include_str!("../../../test/fixtures/native-comparison-catalog.json");
    let catalog = parse_comparison_catalog(catalog_source).map_err(|error| error.code)?;
    for (kind, expected_source) in [
        ("success", direct_canonical.as_str()),
        ("closed-error", direct_canonical.as_str()),
        ("host-boundary", direct_canonical.as_str()),
        ("project-workflow", project_canonical.as_str()),
    ] {
        let workload = catalog
            .workloads
            .iter()
            .find(|workload| workload.kind == kind)
            .ok_or_else(|| "native-comparison-catalog-workload-missing".to_owned())?;
        if workload.source != expected_source {
            return Err("native-comparison-catalog-source-authority-mismatch".to_owned());
        }
    }
    let project_workload = catalog
        .workloads
        .iter()
        .find(|workload| workload.kind == "project-workflow")
        .ok_or_else(|| "native-comparison-catalog-workload-missing".to_owned())?;
    if project_workload.project_digest.as_deref() != Some(project.project_digest.as_str())
        || project_workload.project_module.as_deref() != Some(module_name)
    {
        return Err("native-comparison-catalog-project-authority-mismatch".to_owned());
    }
    let catalog_path = workspace_root.join("comparison-catalog.json");
    let report_path = workspace_root.join("comparison-catalog-report.json");
    write_atomic(&catalog_path, catalog_source.as_bytes())
        .map_err(|_| "native-comparison-catalog-fixture-write-failure".to_owned())?;
    let mut process_count = 0;
    let result = run_native_command(
        binary,
        empty_path,
        workspace_root,
        &[
            "comparison-catalog".to_owned(),
            catalog_path.to_string_lossy().into_owned(),
            project_path.to_string_lossy().into_owned(),
            report_path.to_string_lossy().into_owned(),
        ],
        &mut process_count,
    )?;
    require_success("comparison-catalog", &result)?;
    let report = fs::read(&report_path)
        .map_err(|_| "native-comparison-catalog-report-unreadable".to_owned())?;
    if report != result.stdout {
        return Err("native-comparison-catalog-output-mismatch".to_owned());
    }
    if String::from_utf8_lossy(&report).contains(source_path.to_string_lossy().as_ref())
        || String::from_utf8_lossy(&report).contains(project_path.to_string_lossy().as_ref())
    {
        return Err("native-comparison-catalog-path-leak".to_owned());
    }
    let report_source = String::from_utf8(report.clone())
        .map_err(|_| "native-comparison-catalog-report-invalid-utf8".to_owned())?;
    let parsed_report =
        parse_comparison_report(&catalog, &report_source).map_err(|error| error.code)?;
    let semantic_digest =
        comparison_semantic_digest(&catalog, &parsed_report).map_err(|error| error.code)?;
    Ok((
        digest_bytes(catalog_source.as_bytes()),
        digest_bytes(&report),
        semantic_digest,
        process_count,
    ))
}

fn collect_bundle_comparison_release_evidence(
    binary: &Path,
    project_path: &Path,
    empty_path: &Path,
    workspace_root: &Path,
) -> Result<(String, u32), String> {
    let catalog_source = include_str!("../../../test/fixtures/native-comparison-catalog.json");
    let catalog_digest = digest_bytes(catalog_source.as_bytes());
    let catalog_path = workspace_root.join("bundle-comparison-catalog.json");
    let report_path = workspace_root.join("bundle-comparison-report.json");
    write_atomic(&catalog_path, catalog_source.as_bytes())
        .map_err(|_| "native-release-evidence-bundle-catalog-write-failure".to_owned())?;
    let mut process_count = 0;
    let result = run_native_command(
        binary,
        empty_path,
        workspace_root,
        &[
            "bundle-comparison".to_owned(),
            catalog_path.to_string_lossy().into_owned(),
            project_path.to_string_lossy().into_owned(),
            report_path.to_string_lossy().into_owned(),
        ],
        &mut process_count,
    )?;
    require_success("bundle-comparison", &result)?;
    let report = fs::read(&report_path)
        .map_err(|_| "native-release-evidence-bundle-report-unreadable".to_owned())?;
    if report != result.stdout {
        return Err("native-release-evidence-bundle-output-mismatch".to_owned());
    }
    let report_source = String::from_utf8(report)
        .map_err(|_| "native-release-evidence-bundle-report-invalid-utf8".to_owned())?;
    if report_source.contains(project_path.to_string_lossy().as_ref())
        || report_source.contains(workspace_root.to_string_lossy().as_ref())
    {
        return Err("native-release-evidence-bundle-path-leak".to_owned());
    }
    let parsed =
        parse_bundle_comparison_report(&report_source).map_err(|error| error.code.to_owned())?;
    if parsed.schema != BUNDLE_COMPARISON_SCHEMA
        || parsed.catalog_digest != catalog_digest
        || parsed.observations.len() != 4
    {
        return Err("native-release-evidence-bundle-authority-mismatch".to_owned());
    }
    Ok((parsed.report_digest, process_count))
}

fn collect_project_capability_release_evidence(
    binary: &Path,
    empty_path: &Path,
    workspace_root: &Path,
) -> Result<(String, String, String, String, u32), String> {
    let fixture_root = workspace_root.join("project-capability-fixture");
    let modules_root = fixture_root.join("modules");
    fs::create_dir_all(&modules_root)
        .map_err(|_| "native-release-evidence-project-capability-fixture-failure".to_owned())?;

    let base_source =
        include_str!("../../../test/fixtures/native-capability-comparison-catalog.json");
    let base_catalog =
        parse_capability_comparison_catalog(base_source).map_err(|error| error.code)?;
    let module_metadata = [
        ("args-success", "revia.capability.args_success", "args.re"),
        ("read-success", "revia.capability.read_success", "read.re"),
        (
            "read-missing",
            "revia.capability.read_missing",
            "read-missing.re",
        ),
        (
            "write-success",
            "revia.capability.write_success",
            "write.re",
        ),
    ];
    let expected_workload_count = module_metadata.len();
    if base_catalog.workloads.len() != expected_workload_count {
        return Err("native-release-evidence-project-capability-fixture-mismatch".to_owned());
    }
    let profile_digest = native_profile_digest();
    let toolchain_digest = native_toolchain_digest();
    let mut project_modules = Vec::with_capacity(module_metadata.len());
    let mut package_modules = Vec::with_capacity(module_metadata.len());
    let mut project_workloads = Vec::with_capacity(module_metadata.len());
    for ((expected_id, module_name, filename), workload) in
        module_metadata.into_iter().zip(base_catalog.workloads)
    {
        if workload.workload_id != expected_id {
            return Err("native-release-evidence-project-capability-fixture-mismatch".to_owned());
        }
        let module_path = format!("modules/{filename}");
        let source_digest = format!("sha256:{}", sha256_hex(workload.source.as_bytes()));
        fs::write(fixture_root.join(&module_path), workload.source.as_bytes()).map_err(|_| {
            "native-release-evidence-project-capability-fixture-write-failure".to_owned()
        })?;
        let contract_digest = native_project_capability_contract_digest(module_name);
        project_modules.push(NativeProjectModule::new(
            module_name,
            &module_path,
            source_digest.clone(),
        ));
        package_modules.push(NativeModule::new(
            module_name,
            source_digest,
            NativeInterface::new(
                module_name,
                Vec::new(),
                vec![NativeExport::function("main", contract_digest.clone())],
            ),
        ));
        project_workloads.push(CapabilityProjectComparisonWorkload::new(
            workload.workload_id,
            module_name,
            module_path,
            workload.source,
            workload.operation,
            workload.input_digest,
            workload.sandbox_before,
            workload.sandbox_after,
            workload.expected_outcome_code,
        ));
    }
    let catalog = CapabilityProjectComparisonCatalog::new(project_workloads);
    let catalog_source =
        serialize_capability_project_comparison_catalog(&catalog).map_err(|error| error.code)?;
    let package = NativePackage::new("revia.capability", package_modules);
    let manifest =
        serialize_project_manifest(&project_modules, &package).map_err(|error| error.code)?;
    fs::write(fixture_root.join("project.json"), manifest.as_bytes()).map_err(|_| {
        "native-release-evidence-project-capability-fixture-write-failure".to_owned()
    })?;
    let project = load_project_directory(&fixture_root).map_err(|error| error.code)?;
    let catalog_digest = capability_project_catalog_digest(&catalog).map_err(|error| error.code)?;
    let catalog_path = workspace_root.join("project-capability-catalog.json");
    write_atomic(&catalog_path, catalog_source.as_bytes()).map_err(|_| {
        "native-release-evidence-project-capability-catalog-write-failure".to_owned()
    })?;

    let mut process_count = 0;
    let mut reports = Vec::with_capacity(2);
    let mut report_authority_digest = None;
    for (round, (cache_name, build_name, report_name)) in [
        (
            "project-capability-cache-first",
            "project-capability-build-first",
            "project-capability-report-first.json",
        ),
        (
            "project-capability-cache-second",
            "project-capability-build-second",
            "project-capability-report-second.json",
        ),
    ]
    .into_iter()
    .enumerate()
    {
        let cache_path = workspace_root.join(cache_name);
        let build_path = workspace_root.join(build_name);
        let report_path = workspace_root.join(report_name);
        let result = run_native_command(
            binary,
            empty_path,
            workspace_root,
            &[
                "capability-project-comparison".to_owned(),
                catalog_path.to_string_lossy().into_owned(),
                fixture_root.to_string_lossy().into_owned(),
                cache_path.to_string_lossy().into_owned(),
                build_path.to_string_lossy().into_owned(),
                profile_digest.clone(),
                toolchain_digest.clone(),
                report_path.to_string_lossy().into_owned(),
            ],
            &mut process_count,
        )?;
        require_success("capability-project-comparison", &result)?;
        let report = fs::read(&report_path).map_err(|_| {
            "native-release-evidence-project-capability-report-unreadable".to_owned()
        })?;
        if report != result.stdout {
            return Err("native-release-evidence-project-capability-output-mismatch".to_owned());
        }
        let report_source = String::from_utf8(report).map_err(|_| {
            "native-release-evidence-project-capability-report-invalid-utf8".to_owned()
        })?;
        if report_source.contains(workspace_root.to_string_lossy().as_ref())
            || report_source.contains(fixture_root.to_string_lossy().as_ref())
        {
            return Err("native-release-evidence-project-capability-path-leak".to_owned());
        }
        let parsed_catalog = parse_capability_project_comparison_catalog(&catalog_source)
            .map_err(|error| error.code)?;
        let parsed_report =
            parse_capability_project_comparison_report(&parsed_catalog, &report_source)
                .map_err(|error| error.code)?;
        if parsed_report.schema != CAPABILITY_PROJECT_COMPARISON_REPORT_SCHEMA
            || parsed_report.catalog_digest != catalog_digest
            || parsed_report.observations.len() != expected_workload_count
            || parsed_report
                .observations
                .iter()
                .any(|observation| observation.project_digest != project.project_digest)
        {
            return Err("native-release-evidence-project-capability-authority-mismatch".to_owned());
        }
        if let Some(first_digest) = report_authority_digest.as_deref() {
            if first_digest != parsed_report.report_digest {
                return Err(
                    "native-release-evidence-project-capability-nondeterministic".to_owned(),
                );
            }
        } else {
            report_authority_digest = Some(parsed_report.report_digest.clone());
        }
        if round > 0 && reports.first().is_some_and(|first| first != &report_source) {
            return Err("native-release-evidence-project-capability-nondeterministic".to_owned());
        }
        reports.push(report_source);
    }
    Ok((
        NATIVE_PROJECT_CAPABILITY_COMPARISON_SCHEMA.to_owned(),
        catalog_digest,
        project.project_digest,
        report_authority_digest.ok_or_else(|| {
            "native-release-evidence-project-capability-report-missing".to_owned()
        })?,
        process_count,
    ))
}

fn replay_fault_catalog(catalog_path: &str, output_path: &str) -> Result<(), i32> {
    let catalog_source = fs::read_to_string(catalog_path).map_err(|_| 66)?;
    let catalog = parse_replay_fault_catalog(&catalog_source).map_err(|error| {
        print_replay_fault_catalog_error(&error.code);
        65
    })?;
    let mut observations = Vec::with_capacity(catalog.workloads.len());
    for workload in &catalog.workloads {
        let transcript = parse_native_replay_transcript(&workload.transcript).map_err(|error| {
            print_replay_fault_catalog_error(&error.code);
            65
        })?;
        let transcript_source =
            serialize_native_replay_transcript(&transcript).map_err(|error| {
                print_replay_fault_catalog_error(&error.code);
                65
            })?;
        let transcript_digest = format!("sha256:{}", sha256_hex(transcript_source.as_bytes()));
        let (native, graph_revision) = match read_graph_source_quiet(
            workload.source.as_bytes(),
            &format!("fault-catalog:{}", workload.workload_id),
        ) {
            Err(code) => (
                ReplayFaultResult::measured(
                    "native",
                    None,
                    workload.input_digest.clone(),
                    transcript_digest.clone(),
                    ReplayFaultKind::CheckFailure,
                    code,
                    native_toolchain_digest(),
                ),
                None,
            ),
            Ok(graph) => {
                let revision = graph_revision(&graph).map_err(|error| {
                    print_replay_fault_catalog_error(&error.code);
                    65
                })?;
                match translate_graph(&graph) {
                    Err(error) => (
                        ReplayFaultResult::measured(
                            "native",
                            Some(&revision),
                            workload.input_digest.clone(),
                            transcript_digest.clone(),
                            ReplayFaultKind::CheckFailure,
                            error.code,
                            native_toolchain_digest(),
                        ),
                        Some(revision),
                    ),
                    Ok(artifact) => {
                        let artifact_source =
                            serialize_bytecode_artifact(&artifact).map_err(|error| {
                                print_replay_fault_catalog_error(&error.code);
                                65
                            })?;
                        let request = revia_core::vm::VmRequest::new(
                            revision.clone(),
                            artifact.artifact_digest.clone(),
                            artifact.profile.clone(),
                            &workload.input_digest,
                        );
                        let mut bridge = ReplayBridge::new(transcript);
                        let execution = execute_bytecode(
                            &graph,
                            &artifact_source,
                            &request,
                            &mut bridge,
                            VmLimits::default(),
                        );
                        let observed = if let Some(code) = bridge.failure_code() {
                            (ReplayFaultKind::ReplayMismatch, code.to_owned())
                        } else if let Some((kind, code)) = bridge.observed_failure() {
                            (
                                match kind {
                                    "check-failure" => ReplayFaultKind::CheckFailure,
                                    "host-fault" => ReplayFaultKind::HostFault,
                                    _ => ReplayFaultKind::CheckFailure,
                                },
                                code.to_owned(),
                            )
                        } else {
                            match execution {
                                Err(error) => (ReplayFaultKind::CheckFailure, error.code),
                                Ok(_) => match bridge.finish() {
                                    Err(code) => (ReplayFaultKind::ReplayMismatch, code),
                                    Ok(()) => {
                                        print_replay_fault_catalog_error(
                                            "replay-fault-success-failure-confusion",
                                        );
                                        return Err(65);
                                    }
                                },
                            }
                        };
                        (
                            ReplayFaultResult::measured(
                                "native",
                                Some(&revision),
                                workload.input_digest.clone(),
                                transcript_digest.clone(),
                                observed.0,
                                observed.1,
                                native_toolchain_digest(),
                            ),
                            Some(revision),
                        )
                    }
                }
            }
        };
        if native.kind != workload.expected_kind || native.code != workload.code {
            print_replay_fault_catalog_error("replay-fault-expectation-mismatch");
            return Err(65);
        }
        let node = workload.node_fault.clone();
        let pending = if node.is_some() {
            vec![("go", "not-measured"), ("jvm", "not-measured")]
        } else {
            vec![
                ("node", "not-supplied"),
                ("go", "not-measured"),
                ("jvm", "not-measured"),
            ]
        };
        observations.push(ReplayFaultWorkloadObservation::new(
            workload.workload_id.clone(),
            graph_revision.as_deref(),
            workload.input_digest.clone(),
            transcript_digest,
            native,
            node,
            pending,
        ));
    }
    let report = build_replay_fault_report(&catalog, observations).map_err(|error| {
        print_replay_fault_catalog_error(&error.code);
        65
    })?;
    let output = serialize_replay_fault_report(&report).map_err(|error| {
        print_replay_fault_catalog_error(&error.code);
        65
    })?;
    write_atomic(Path::new(output_path), output.as_bytes()).map_err(|_| {
        print_replay_fault_catalog_error("replay-fault-report-write-failure");
        74
    })?;
    print!("{output}");
    Ok(())
}

fn replay_fault_corpus(corpus_path: &str, output_path: &str) -> Result<(), i32> {
    let corpus_source = fs::read_to_string(corpus_path).map_err(|_| 66)?;
    let corpus = parse_native_fault_corpus(&corpus_source).map_err(|error| {
        print_native_fault_corpus_error(&error.code);
        65
    })?;
    let mut observations = Vec::with_capacity(corpus.cases.len());
    for case in &corpus.cases {
        let observation = observe_native_fault_case(case).map_err(|code| {
            print_native_fault_corpus_error(&code);
            65
        })?;
        if observation.stage != case.expected_stage
            || observation.kind != case.expected_kind
            || observation.code != case.expected_code
        {
            print_native_fault_corpus_error("native-fault-corpus-expectation-mismatch");
            return Err(65);
        }
        observations.push(observation);
    }
    let report = build_native_fault_corpus_report(
        &corpus,
        observations,
        vec![
            NativeFaultPendingBackend::new("node", "not-measured"),
            NativeFaultPendingBackend::new("go", "not-measured"),
            NativeFaultPendingBackend::new("jvm", "not-measured"),
        ],
    )
    .map_err(|error| {
        print_native_fault_corpus_error(&error.code);
        65
    })?;
    let output = serialize_native_fault_corpus_report(&report).map_err(|error| {
        print_native_fault_corpus_error(&error.code);
        65
    })?;
    write_atomic(Path::new(output_path), output.as_bytes()).map_err(|_| {
        print_native_fault_corpus_error("native-fault-report-write-failure");
        74
    })?;
    print!("{output}");
    Ok(())
}

fn replay_fault_corpus_gate(corpus_path: &str, evidence_path: &str) -> Result<(), i32> {
    let result = (|| -> Result<String, String> {
        let corpus_path = absolute_input_path(Path::new(corpus_path))
            .map_err(|_| "native-fault-release-corpus-unreadable".to_owned())?;
        let binary =
            env::current_exe().map_err(|_| "native-fault-release-binary-unreadable".to_owned())?;
        let binary_metadata = fs::symlink_metadata(&binary)
            .map_err(|_| "native-fault-release-binary-unreadable".to_owned())?;
        if !binary_metadata.file_type().is_file() {
            return Err("native-fault-release-binary-not-regular".to_owned());
        }
        if !binary
            .components()
            .any(|component| component.as_os_str() == "release")
        {
            return Err("native-fault-corpus-release-binary-required".to_owned());
        }
        let binary_digest = format!(
            "sha256:{}",
            sha256_hex(
                &fs::read(&binary)
                    .map_err(|_| "native-fault-release-binary-unreadable".to_owned())?,
            )
        );
        static_node_dependency_scan(&binary)?;

        let corpus_source = fs::read_to_string(&corpus_path)
            .map_err(|_| "native-fault-release-corpus-unreadable".to_owned())?;
        let corpus = parse_native_fault_corpus(&corpus_source).map_err(|error| error.code)?;
        let empty_path = make_empty_path()?;
        let temp_root = empty_path
            .parent()
            .ok_or_else(|| "native-fault-release-temporary-directory-failure".to_owned())?
            .to_path_buf();
        let report_path = temp_root.join("fault-report.json");
        let mut command = process::Command::new(&binary);
        command.args([
            "replay-fault-corpus",
            corpus_path.to_string_lossy().as_ref(),
            report_path.to_string_lossy().as_ref(),
        ]);
        configure_empty_path_command(&mut command, Path::new(""));
        let child = command
            .current_dir(&empty_path)
            .output()
            .map_err(|_| "native-fault-release-runner-failure".to_owned())?;
        if !child.status.success() || !child.stderr.is_empty() {
            let detail = [&child.stdout, &child.stderr]
                .iter()
                .find_map(|bytes| stable_diagnostic_code(bytes));
            fs::remove_dir_all(&temp_root).ok();
            return Err(match detail {
                Some(code) => format!("native-fault-release-runner-failure-{code}"),
                None => "native-fault-release-runner-failure".to_owned(),
            });
        }
        let report_source = fs::read_to_string(&report_path)
            .map_err(|_| "native-fault-release-report-unreadable".to_owned())?;
        if child.stdout != report_source.as_bytes() {
            fs::remove_dir_all(&temp_root).ok();
            return Err("native-fault-release-report-output-mismatch".to_owned());
        }
        let report =
            parse_native_fault_corpus_report(&report_source).map_err(|error| error.code)?;
        let evidence = build_native_fault_corpus_release_evidence(
            &corpus,
            &report,
            NativeFaultReleaseRun {
                binary_digest,
                toolchain_digest: native_toolchain_digest(),
                release_build: true,
                empty_path: true,
                process_count: 1,
                node_process_count: 0,
                node_load_count: 0,
                node_import_count: 0,
            },
        )
        .map_err(|error| error.code)?;
        let output = serialize_native_fault_corpus_release_evidence(&corpus, &report, &evidence)
            .map_err(|error| error.code)?;
        fs::remove_dir_all(&temp_root).ok();
        write_atomic(Path::new(evidence_path), output.as_bytes())
            .map_err(|_| "native-fault-release-evidence-write-failure".to_owned())?;
        Ok(output)
    })();
    match result {
        Ok(output) => {
            print!("{output}");
            Ok(())
        }
        Err(code) => {
            print_native_fault_release_error(&code);
            Err(65)
        }
    }
}

fn observe_native_fault_case(
    case: &NativeFaultCorpusCase,
) -> Result<NativeFaultObservation, String> {
    let transcript =
        parse_native_replay_transcript(&case.transcript).map_err(|error| error.code)?;
    let transcript_source =
        serialize_native_replay_transcript(&transcript).map_err(|error| error.code)?;
    let transcript_digest = format!("sha256:{}", sha256_hex(transcript_source.as_bytes()));
    let source_digest = format!("sha256:{}", sha256_hex(case.source.as_bytes()));
    let observation = match read_graph_source_quiet(
        case.source.as_bytes(),
        &format!("fault-corpus:{}", case.case_id),
    ) {
        Err(code) => NativeFaultObservation::measured(
            &case.case_id,
            &case.source,
            None,
            case.input_digest.clone(),
            &transcript_source,
            FaultStage::CheckedError,
            ReplayFaultKind::CheckFailure,
            code,
            FaultEvidenceScope::Exercised,
        ),
        Ok(graph) => {
            let revision = graph_revision(&graph).map_err(|error| error.code)?;
            match translate_graph(&graph) {
                Err(error) => NativeFaultObservation::measured(
                    &case.case_id,
                    &case.source,
                    Some(&revision),
                    case.input_digest.clone(),
                    &transcript_source,
                    FaultStage::CheckedError,
                    ReplayFaultKind::CheckFailure,
                    error.code,
                    FaultEvidenceScope::Exercised,
                ),
                Ok(artifact) => {
                    let artifact_source =
                        serialize_bytecode_artifact(&artifact).map_err(|error| error.code)?;
                    let request = revia_core::vm::VmRequest::new(
                        revision.clone(),
                        artifact.artifact_digest.clone(),
                        artifact.profile.clone(),
                        &case.input_digest,
                    );
                    let mut bridge = ReplayBridge::new(transcript);
                    let execution = execute_bytecode(
                        &graph,
                        &artifact_source,
                        &request,
                        &mut bridge,
                        VmLimits::default(),
                    );
                    let (stage, kind, code) = if let Some(code) = bridge.failure_code() {
                        (
                            FaultStage::ReplayMismatch,
                            ReplayFaultKind::ReplayMismatch,
                            code.to_owned(),
                        )
                    } else if let Some((kind, code)) = bridge.observed_failure() {
                        match kind {
                            "host-fault" => (
                                FaultStage::HostObservation,
                                ReplayFaultKind::HostFault,
                                code.to_owned(),
                            ),
                            "check-failure" => (
                                FaultStage::HostObservation,
                                ReplayFaultKind::CheckFailure,
                                code.to_owned(),
                            ),
                            _ => {
                                return Err(
                                    "native-fault-corpus-observation-kind-invalid".to_owned()
                                );
                            }
                        }
                    } else {
                        match execution {
                            Err(error) => (
                                FaultStage::CheckedError,
                                ReplayFaultKind::CheckFailure,
                                error.code,
                            ),
                            Ok(_) => match bridge.finish() {
                                Err(code) => (
                                    FaultStage::ReplayMismatch,
                                    ReplayFaultKind::ReplayMismatch,
                                    code,
                                ),
                                Ok(()) => {
                                    return Err(
                                        "native-fault-corpus-success-failure-confusion".to_owned()
                                    );
                                }
                            },
                        }
                    };
                    NativeFaultObservation::measured(
                        &case.case_id,
                        &case.source,
                        Some(&revision),
                        case.input_digest.clone(),
                        &transcript_source,
                        stage,
                        kind,
                        code,
                        FaultEvidenceScope::Exercised,
                    )
                }
            }
        }
    };
    if observation.source_digest != source_digest
        || observation.transcript_digest != transcript_digest
    {
        return Err("native-fault-corpus-authority-mismatch".to_owned());
    }
    Ok(observation)
}

fn native_toolchain_digest() -> String {
    format!("sha256:{}", sha256_hex(b"re.native-rust-toolchain@0.1.0"))
}

fn native_profile_digest() -> String {
    format!("sha256:{}", sha256_hex(NATIVE_BYTECODE_PROFILE.as_bytes()))
}

fn native_project_capability_contract_digest(module_name: &str) -> String {
    let contract = format!("{module_name}.main:{PROJECT_CAPABILITY_ENTRY_RESULT}");
    format!("sha256:{}", sha256_hex(contract.as_bytes()))
}

fn resolve_sqlite_executable(executable: &str) -> Result<(PathBuf, String), String> {
    let requested = Path::new(executable);
    if executable.is_empty() {
        return Err("native-project-server-gate-sqlite-executable-invalid".to_owned());
    }
    let candidate = if requested.is_absolute() {
        requested.to_path_buf()
    } else if requested.components().count() == 1 {
        let paths = env::var_os("PATH")
            .map(|paths| env::split_paths(&paths).collect::<Vec<_>>())
            .unwrap_or_default();
        paths
            .into_iter()
            .map(|directory| directory.join(requested))
            .find(|path| fs::metadata(path).is_ok())
            .ok_or_else(|| "native-project-server-gate-sqlite-unavailable".to_owned())?
    } else {
        return Err("native-project-server-gate-sqlite-executable-invalid".to_owned());
    };
    let metadata = fs::metadata(&candidate)
        .map_err(|_| "native-project-server-gate-sqlite-unavailable".to_owned())?;
    if !metadata.is_file() {
        return Err("native-project-server-gate-sqlite-executable-invalid".to_owned());
    }
    let canonical = fs::canonicalize(&candidate)
        .map_err(|_| "native-project-server-gate-sqlite-unavailable".to_owned())?;
    let bytes = fs::read(&canonical)
        .map_err(|_| "native-project-server-gate-sqlite-unavailable".to_owned())?;
    Ok((canonical, format!("sha256:{}", sha256_hex(&bytes))))
}

fn next_workspace_id() -> u64 {
    TEMP_WORKSPACE_COUNTER.fetch_add(1, Ordering::Relaxed)
}

fn native_temp_root(label: &str) -> PathBuf {
    env::temp_dir().join(format!(
        "revia-{label}-{}-{}",
        process::id(),
        next_workspace_id()
    ))
}

fn server_smoke() -> Result<(), i32> {
    let limits = HttpLimits::new(4096, 128, 256).map_err(|_| server_smoke_failure("limits"))?;
    let (listener, address) =
        bind_loopback_listener().map_err(|error| server_smoke_io_failure("bind", &error))?;
    let router = Arc::new(
        HttpRouter::new(vec![
            HttpRoute::new("GET", "/health", "health")
                .map_err(|_| server_smoke_failure("route"))?,
        ])
        .map_err(|_| server_smoke_failure("router"))?,
    );
    let cancellation = Arc::new(ServerCancellation::new());
    let server_router = Arc::clone(&router);
    let server_cancellation = Arc::clone(&cancellation);
    let server = thread::spawn(move || {
        let mut handler = CliHealthHandler;
        serve_once(
            &listener,
            &server_router,
            &mut handler,
            &limits,
            &server_cancellation,
        )
    });

    let mut client = TcpStream::connect(address).map_err(|_| server_smoke_failure("connect"))?;
    client
        .write_all(b"GET /health HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n")
        .map_err(|_| server_smoke_failure("request-write"))?;
    let mut response = Vec::new();
    client
        .read_to_end(&mut response)
        .map_err(|_| server_smoke_failure("response-read"))?;
    let receipt = server
        .join()
        .map_err(|_| server_smoke_failure("server-join"))?
        .map_err(|_| server_smoke_failure("server-serve"))?;
    let response =
        String::from_utf8(response).map_err(|_| server_smoke_failure("response-utf8"))?;
    let body = response
        .split_once("\r\n\r\n")
        .map(|(_, body)| body)
        .unwrap_or_default();
    println!(
        "{{\"body\":{},\"route_id\":{},\"schema\":{},\"status\":{},\"transport\":\"loopback\"}}",
        quote(body),
        quote(&receipt.route_id),
        quote("re.native-server-smoke@0.1.0"),
        receipt.status,
    );
    Ok(())
}

fn server_smoke_failure(stage: &str) -> i32 {
    eprintln!(
        "{{\"diagnostics\":[{{\"code\":{}}}],\"ok\":false,\"schema\":{}}}",
        quote(&server_smoke_failure_code(stage)),
        quote("re.native-server-smoke@0.1.0"),
    );
    70
}

fn server_smoke_io_failure(stage: &str, error: &std::io::Error) -> i32 {
    let kind = match error.kind() {
        std::io::ErrorKind::PermissionDenied => "permission-denied".to_owned(),
        std::io::ErrorKind::AddrNotAvailable => "address-not-available".to_owned(),
        std::io::ErrorKind::AddrInUse => "address-in-use".to_owned(),
        _ => error
            .raw_os_error()
            .map(|code| format!("os-{code}"))
            .unwrap_or_else(|| "io-error".to_owned()),
    };
    server_smoke_failure(&format!("{stage}-{kind}"))
}

fn server_smoke_failure_code(stage: &str) -> String {
    format!("native-server-smoke-{stage}-failure")
}

fn bind_loopback_listener() -> std::io::Result<(TcpListener, std::net::SocketAddr)> {
    let mut last_error = None;
    for address in ["127.0.0.1:0", "127.0.0.2:0", "[::1]:0"] {
        match TcpListener::bind(address) {
            Ok(listener) => {
                let address = listener.local_addr()?;
                return Ok((listener, address));
            }
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::AddrNotAvailable,
            "no loopback bind candidate",
        )
    }))
}

fn project_server_smoke(
    project_path: &str,
    module_name: &str,
    profile_digest: &str,
    toolchain_digest: &str,
    input_digest: &str,
) -> Result<(), i32> {
    let workspace = temporary_project_workspace("server")?;
    let result = (|| {
        if !is_valid_digest(input_digest) {
            eprintln!(
                "{{\"diagnostics\":[{{\"code\":{}}}],\"ok\":false,\"schema\":{}}}",
                quote("native-vm-request-input-digest-invalid"),
                quote("re.native-project-server-result@0.1.0"),
            );
            return Err(65);
        }
        let limits = HttpLimits::new(4096, 128, 16 * 1024).map_err(|_| 70)?;
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|_| 70)?;
        let address = listener.local_addr().map_err(|_| 70)?;
        let router = Arc::new(
            HttpRouter::new(vec![
                HttpRoute::new("GET", "/run", "project-run").map_err(|_| 70)?,
            ])
            .map_err(|_| 70)?,
        );
        let cancellation = Arc::new(ServerCancellation::new());
        let server_router = Arc::clone(&router);
        let server_cancellation = Arc::clone(&cancellation);
        let handler_workspace = workspace.clone();
        let handler_project = project_path.to_owned();
        let handler_module = module_name.to_owned();
        let handler_profile = profile_digest.to_owned();
        let handler_toolchain = toolchain_digest.to_owned();
        let handler_input = input_digest.to_owned();
        let server = thread::spawn(move || {
            let mut handler = ProjectRunHandler {
                project_path: handler_project,
                workspace: handler_workspace,
                module_name: handler_module,
                profile_digest: handler_profile,
                toolchain_digest: handler_toolchain,
                input_digest: handler_input,
                error_code: None,
            };
            let result = serve_once(
                &listener,
                &server_router,
                &mut handler,
                &limits,
                &server_cancellation,
            );
            (result, handler.error_code)
        });

        let mut client = TcpStream::connect(address).map_err(|_| 70)?;
        client
            .write_all(b"GET /run HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n")
            .map_err(|_| 70)?;
        let mut response = Vec::new();
        client.read_to_end(&mut response).map_err(|_| 70)?;
        let (receipt, error_code) = server.join().map_err(|_| 70)?;
        let receipt = match receipt {
            Ok(receipt) => receipt,
            Err(_) => {
                if let Some(code) = error_code {
                    eprintln!(
                        "{{\"diagnostics\":[{{\"code\":{}}}],\"ok\":false,\"schema\":{}}}",
                        quote(&code),
                        quote("re.native-project-server-result@0.1.0"),
                    );
                }
                return Err(65);
            }
        };
        let response = String::from_utf8(response).map_err(|_| 70)?;
        let body = response
            .split_once("\r\n\r\n")
            .map(|(_, body)| body)
            .unwrap_or_default();
        println!(
            "{{\"body\":{},\"route_id\":{},\"schema\":{},\"status\":{},\"transport\":\"loopback\"}}",
            quote(body),
            quote(&receipt.route_id),
            quote("re.native-project-server-smoke@0.1.0"),
            receipt.status,
        );
        Ok(())
    })();
    fs::remove_dir_all(&workspace).ok();
    result
}

fn node_free_gate(
    source_path: &str,
    project_path: &str,
    module_name: &str,
    report_path: &str,
) -> Result<(), i32> {
    let result = absolute_input_path(Path::new(source_path))
        .and_then(|source| {
            absolute_input_path(Path::new(project_path)).map(|project| (source, project))
        })
        .and_then(|(source, project)| build_node_free_report(&source, &project, module_name))
        .and_then(|report| {
            let output = serialize_node_free_report(&report).map_err(|error| error.code)?;
            write_atomic(Path::new(report_path), output.as_bytes())
                .map_err(|_| "node-free-report-write-failure".to_owned())?;
            Ok(output)
        });
    match result {
        Ok(output) => {
            print!("{output}");
            Ok(())
        }
        Err(code) => {
            print_node_free_error(&code);
            Err(65)
        }
    }
}

fn release_evidence_gate(
    source_path: &str,
    project_path: &str,
    module_name: &str,
    corpus_path: &str,
    evidence_path: &str,
) -> Result<(), i32> {
    let result = (|| -> Result<String, String> {
        let source_path = absolute_input_path(Path::new(source_path))?;
        let project_path = absolute_input_path(Path::new(project_path))?;
        let corpus_path = absolute_input_path(Path::new(corpus_path))?;
        let binary = env::current_exe()
            .map_err(|_| "native-release-evidence-binary-unreadable".to_owned())?;
        let metadata = fs::symlink_metadata(&binary)
            .map_err(|_| "native-release-evidence-binary-unreadable".to_owned())?;
        if !metadata.file_type().is_file() {
            return Err("native-release-evidence-binary-not-regular".to_owned());
        }
        if cfg!(debug_assertions) {
            return Err("native-release-evidence-release-binary-required".to_owned());
        }
        if !binary
            .components()
            .any(|component| component.as_os_str() == "release")
        {
            return Err("native-release-evidence-release-binary-required".to_owned());
        }
        let binary_digest = format!(
            "sha256:{}",
            sha256_hex(
                &fs::read(&binary)
                    .map_err(|_| "native-release-evidence-binary-unreadable".to_owned())?,
            )
        );
        static_node_dependency_scan(&binary)?;
        let source_inventory = source_inventory_digest(&source_path, &project_path)?;
        let node_report = build_node_free_report(&source_path, &project_path, module_name)?;
        if node_report.binary_digest != binary_digest
            || node_report.source_inventory_digest != source_inventory
        {
            return Err("native-release-evidence-node-free-authority-mismatch".to_owned());
        }
        let project = load_project_directory(&project_path).map_err(|error| error.code)?;
        let workspace = make_empty_path()?;
        let workspace_root = workspace
            .parent()
            .ok_or_else(|| "native-release-evidence-temporary-directory-failure".to_owned())?
            .to_path_buf();
        let (deterministic_build, deterministic_process_count) =
            deterministic_project_build_evidence(
                &binary,
                &project_path,
                &workspace,
                &workspace_root,
                &node_report.profile_digest,
                &node_report.toolchain_digest,
            )?;
        let fault_evidence = collect_fault_release_evidence(&binary, &corpus_path, &workspace)?;
        if fault_evidence.binary_digest != binary_digest {
            return Err("native-release-evidence-fault-binary-mismatch".to_owned());
        }
        let (
            comparison_fixture_digest,
            comparison_report_digest,
            comparison_semantic_digest,
            comparison_process_count,
        ) = collect_comparison_release_evidence(
            &binary,
            &source_path,
            &project_path,
            module_name,
            &workspace,
            &workspace_root,
        )?;
        let (bundle_comparison_report_digest, bundle_comparison_process_count) =
            collect_bundle_comparison_release_evidence(
                &binary,
                &project_path,
                &workspace,
                &workspace_root,
            )?;
        let (
            project_capability_schema,
            project_capability_catalog_digest,
            project_capability_project_digest,
            project_capability_report_digest,
            project_capability_process_count,
        ) = collect_project_capability_release_evidence(&binary, &workspace, &workspace_root)?;
        let evidence = build_native_release_evidence(
            &binary_digest,
            &fault_evidence.toolchain_digest,
            &source_inventory,
            &project.project_digest,
            &node_report.stable_digest,
            &workload_digest(&node_report.workloads),
            &fault_evidence.corpus_digest,
            &fault_evidence.report_digest,
            &fault_evidence.stable_digest,
            deterministic_build,
            &comparison_fixture_digest,
            vec![
                NativeComparisonCandidate::measured(
                    "native",
                    &comparison_fixture_digest,
                    comparison_semantic_digest,
                    comparison_report_digest,
                ),
                NativeComparisonCandidate::pending(
                    "node",
                    &comparison_fixture_digest,
                    "migration-oracle-only",
                ),
                NativeComparisonCandidate::pending(
                    "go",
                    &comparison_fixture_digest,
                    "not-measured",
                ),
                NativeComparisonCandidate::pending(
                    "jvm",
                    &comparison_fixture_digest,
                    "not-measured",
                ),
            ],
            &bundle_comparison_report_digest,
            &project_capability_schema,
            &project_capability_catalog_digest,
            &project_capability_project_digest,
            &project_capability_report_digest,
            NativeReleaseRun {
                release_build: true,
                empty_path: true,
                process_count: node_report
                    .process_count
                    .saturating_add(fault_evidence.process_count)
                    .saturating_add(deterministic_process_count)
                    .saturating_add(comparison_process_count)
                    .saturating_add(bundle_comparison_process_count)
                    .saturating_add(project_capability_process_count),
                node_process_count: node_report.node_process_count,
                node_load_count: node_report.node_load_count,
                node_import_count: node_report.node_import_count,
            },
        )
        .map_err(|error| error.code)?;
        let output = serialize_native_release_evidence(&evidence).map_err(|error| error.code)?;
        fs::remove_dir_all(&workspace_root).ok();
        write_atomic(Path::new(evidence_path), output.as_bytes())
            .map_err(|_| "native-release-evidence-write-failure".to_owned())?;
        Ok(output)
    })();
    match result {
        Ok(output) => {
            print!("{output}");
            Ok(())
        }
        Err(code) => {
            eprintln!(
                "{{\"diagnostics\":[{{\"code\":{}}}],\"ok\":false,\"schema\":{}}}",
                quote(&code),
                quote("re.native-release-evidence@0.4.0"),
            );
            Err(65)
        }
    }
}

fn collect_fault_release_evidence(
    binary: &Path,
    corpus_path: &Path,
    empty_path: &Path,
) -> Result<revia_core::fault_corpus::NativeFaultCorpusReleaseEvidence, String> {
    let root = empty_path
        .parent()
        .ok_or_else(|| "native-release-evidence-temporary-directory-failure".to_owned())?;
    let evidence_path = root.join("fault-release-evidence.json");
    let mut command = process::Command::new(binary);
    command.args([
        "replay-fault-corpus-gate".to_owned(),
        corpus_path.to_string_lossy().into_owned(),
        evidence_path.to_string_lossy().into_owned(),
    ]);
    configure_empty_path_command(&mut command, empty_path);
    let child = command
        .current_dir(empty_path)
        .output()
        .map_err(|_| "native-release-evidence-fault-runner-failure".to_owned())?;
    if !child.status.success() || !child.stderr.is_empty() {
        let detail = [&child.stdout, &child.stderr]
            .iter()
            .find_map(|bytes| stable_diagnostic_code(bytes));
        return Err(match detail {
            Some(code) => format!("native-release-evidence-fault-runner-failure-{code}"),
            None => "native-release-evidence-fault-runner-failure".to_owned(),
        });
    }
    let output = fs::read(&evidence_path)
        .map_err(|_| "native-release-evidence-fault-output-unreadable".to_owned())?;
    if child.stdout != output {
        return Err("native-release-evidence-fault-output-mismatch".to_owned());
    }
    let source = String::from_utf8(output)
        .map_err(|_| "native-release-evidence-fault-output-invalid".to_owned())?;
    parse_native_fault_corpus_release_evidence(&source).map_err(|error| error.code)
}

fn deterministic_project_build_evidence(
    binary: &Path,
    project_path: &Path,
    empty_path: &Path,
    workspace_root: &Path,
    profile_digest: &str,
    toolchain_digest: &str,
) -> Result<(NativeDeterministicBuildEvidence, u32), String> {
    let first_root = workspace_root.join("deterministic-build-first");
    let second_root = workspace_root.join("deterministic-build-second");
    fs::create_dir_all(&first_root)
        .map_err(|_| "native-release-evidence-temporary-directory-failure".to_owned())?;
    fs::create_dir_all(&second_root)
        .map_err(|_| "native-release-evidence-temporary-directory-failure".to_owned())?;
    let build_args = |root: &Path| {
        vec![
            "project-build".to_owned(),
            project_path.to_string_lossy().into_owned(),
            root.join("cache").to_string_lossy().into_owned(),
            root.join("build").to_string_lossy().into_owned(),
            profile_digest.to_owned(),
            toolchain_digest.to_owned(),
        ]
    };
    let mut process_count = 0;
    let first_result = run_native_command(
        binary,
        empty_path,
        &first_root,
        &build_args(&first_root),
        &mut process_count,
    )?;
    require_success("deterministic-build-first", &first_result)?;
    let second_result = run_native_command(
        binary,
        empty_path,
        &second_root,
        &build_args(&second_root),
        &mut process_count,
    )?;
    require_success("deterministic-build-second", &second_result)?;
    let first_manifest = read_published_build_manifest(&first_root.join("build"))?;
    let second_manifest = read_published_build_manifest(&second_root.join("build"))?;
    let first_tree = build_tree_digest(&first_root)?;
    let second_tree = build_tree_digest(&second_root)?;
    Ok((
        NativeDeterministicBuildEvidence::new(
            digest_bytes(&first_manifest),
            digest_bytes(&second_manifest),
            &first_tree,
            &second_tree,
        ),
        process_count,
    ))
}

fn read_published_build_manifest(build_root: &Path) -> Result<Vec<u8>, String> {
    let mut entries = Vec::new();
    collect_inventory(build_root, "build", &mut entries)?;
    let manifests = entries
        .into_iter()
        .filter(|(path, _)| path.ends_with("/build.json"))
        .collect::<Vec<_>>();
    if manifests.len() != 1 {
        return Err("native-release-evidence-build-manifest-invalid".to_owned());
    }
    Ok(manifests.into_iter().next().unwrap().1)
}

fn build_tree_digest(root: &Path) -> Result<String, String> {
    let mut entries = Vec::new();
    collect_inventory(&root.join("cache"), "cache", &mut entries)?;
    collect_inventory(&root.join("build"), "build", &mut entries)?;
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    let mut bytes = Vec::new();
    for (path, content) in entries {
        bytes.extend_from_slice(path.as_bytes());
        bytes.push(0);
        bytes.extend_from_slice(&(content.len() as u64).to_be_bytes());
        bytes.extend_from_slice(&content);
    }
    Ok(digest_bytes(&bytes))
}

fn developer_gate(
    project_path: &str,
    module_name: &str,
    input_digest: &str,
    report_path: &str,
) -> Result<(), i32> {
    let project_path = absolute_input_path(Path::new(project_path)).map_err(|_| 66)?;
    let report_path = absolute_input_path(Path::new(report_path)).map_err(|_| 66)?;
    if path_is_within(&project_path, &report_path) {
        eprintln!("native-developer-gate-report-inside-project");
        return Err(65);
    }
    let binary = env::current_exe().map_err(|_| 70)?;
    let root = native_temp_root("developer-gate");
    let empty_path = root.join("empty-path");
    let first_root = root.join("first");
    let second_root = root.join("second");
    if fs::create_dir_all(&empty_path).is_err()
        || fs::create_dir_all(&first_root).is_err()
        || fs::create_dir_all(&second_root).is_err()
    {
        fs::remove_dir_all(&root).ok();
        eprintln!("native-developer-gate-temporary-directory-failure");
        return Err(74);
    }

    let result = (|| -> Result<String, String> {
        let mut process_count = 0;
        let check = run_native_command(
            &binary,
            &empty_path,
            &first_root,
            &[
                "project-check".to_owned(),
                project_path.to_string_lossy().into_owned(),
            ],
            &mut process_count,
        )?;
        require_developer_stage("project-check", &check)?;

        let project_test = run_native_command(
            &binary,
            &empty_path,
            &first_root,
            &[
                "project-test".to_owned(),
                project_path.to_string_lossy().into_owned(),
            ],
            &mut process_count,
        )?;
        require_developer_stage("project-test", &project_test)?;

        let build_args = |workspace: &Path| {
            vec![
                "project-build".to_owned(),
                project_path.to_string_lossy().into_owned(),
                workspace.join("cache").to_string_lossy().into_owned(),
                workspace.join("build").to_string_lossy().into_owned(),
                PROJECT_INIT_PROFILE_DIGEST.to_owned(),
                PROJECT_INIT_TOOLCHAIN_DIGEST.to_owned(),
            ]
        };
        let first_build = run_native_command(
            &binary,
            &empty_path,
            &first_root,
            &build_args(&first_root),
            &mut process_count,
        )?;
        require_developer_stage("project-build-first", &first_build)?;
        let second_build = run_native_command(
            &binary,
            &empty_path,
            &second_root,
            &build_args(&second_root),
            &mut process_count,
        )?;
        require_developer_stage("project-build-second", &second_build)?;

        let first_manifest = read_published_build_manifest(&first_root.join("build"))?;
        let second_manifest = read_published_build_manifest(&second_root.join("build"))?;
        let first_manifest_digest = digest_bytes(&first_manifest);
        let second_manifest_digest = digest_bytes(&second_manifest);
        let first_tree_digest = build_tree_digest(&first_root)?;
        let second_tree_digest = build_tree_digest(&second_root)?;
        if first_manifest_digest != second_manifest_digest
            || first_tree_digest != second_tree_digest
        {
            return Err("native-developer-gate-build-nondeterministic".to_owned());
        }

        let project_translate = run_native_command(
            &binary,
            &empty_path,
            &first_root,
            &[
                "project-translate".to_owned(),
                project_path.to_string_lossy().into_owned(),
                first_root.join("cache").to_string_lossy().into_owned(),
                first_root.join("build").to_string_lossy().into_owned(),
                PROJECT_INIT_PROFILE_DIGEST.to_owned(),
                PROJECT_INIT_TOOLCHAIN_DIGEST.to_owned(),
                module_name.to_owned(),
            ],
            &mut process_count,
        )?;
        require_developer_stage("project-translate", &project_translate)?;

        let project_run = run_native_command(
            &binary,
            &empty_path,
            &first_root,
            &[
                "project-run".to_owned(),
                project_path.to_string_lossy().into_owned(),
                first_root.join("cache").to_string_lossy().into_owned(),
                first_root.join("build").to_string_lossy().into_owned(),
                PROJECT_INIT_PROFILE_DIGEST.to_owned(),
                PROJECT_INIT_TOOLCHAIN_DIGEST.to_owned(),
                module_name.to_owned(),
                input_digest.to_owned(),
            ],
            &mut process_count,
        )?;
        require_developer_stage("project-run", &project_run)?;

        let project =
            load_project_directory(&project_path).map_err(|error| error.code.to_owned())?;
        let value = JsonValue::Object(vec![
            (
                "build".to_owned(),
                JsonValue::Object(vec![
                    (
                        "first_manifest_digest".to_owned(),
                        JsonValue::String(first_manifest_digest),
                    ),
                    (
                        "first_tree_digest".to_owned(),
                        JsonValue::String(first_tree_digest),
                    ),
                    (
                        "second_manifest_digest".to_owned(),
                        JsonValue::String(second_manifest_digest),
                    ),
                    (
                        "second_tree_digest".to_owned(),
                        JsonValue::String(second_tree_digest),
                    ),
                ]),
            ),
            (
                "graph_revision".to_owned(),
                JsonValue::String(project.graph_revision),
            ),
            (
                "input_digest".to_owned(),
                JsonValue::String(input_digest.to_owned()),
            ),
            (
                "module".to_owned(),
                JsonValue::String(module_name.to_owned()),
            ),
            (
                "project_check_digest".to_owned(),
                JsonValue::String(digest_bytes(&check.stdout)),
            ),
            (
                "project_digest".to_owned(),
                JsonValue::String(project.project_digest),
            ),
            (
                "project_run_digest".to_owned(),
                JsonValue::String(digest_bytes(&project_run.stdout)),
            ),
            (
                "project_test_digest".to_owned(),
                JsonValue::String(digest_bytes(&project_test.stdout)),
            ),
            (
                "project_translate_digest".to_owned(),
                JsonValue::String(digest_bytes(&project_translate.stdout)),
            ),
            ("reproducible".to_owned(), JsonValue::Bool(true)),
            (
                "schema".to_owned(),
                JsonValue::String(DEVELOPER_GATE_SCHEMA.to_owned()),
            ),
            ("status".to_owned(), JsonValue::String("passed".to_owned())),
            (
                "toolchain_digest".to_owned(),
                JsonValue::String(PROJECT_INIT_TOOLCHAIN_DIGEST.to_owned()),
            ),
            (
                "profile_digest".to_owned(),
                JsonValue::String(PROJECT_INIT_PROFILE_DIGEST.to_owned()),
            ),
        ]);
        let report_digest = digest_bytes(canonicalize(&value).as_bytes());
        let JsonValue::Object(mut fields) = value else {
            unreachable!();
        };
        fields.push(("report_digest".to_owned(), JsonValue::String(report_digest)));
        Ok(format!("{}\n", canonicalize(&JsonValue::Object(fields))))
    })();
    fs::remove_dir_all(&root).ok();

    match result {
        Ok(report) => {
            if write_atomic(&report_path, report.as_bytes()).is_err() {
                eprintln!("native-developer-gate-report-write-failure");
                return Err(74);
            }
            print!("{report}");
            Ok(())
        }
        Err(code) => {
            eprintln!("{code}");
            Err(65)
        }
    }
}

fn toolchain_gate(
    source_path: &str,
    project_path: &str,
    module_name: &str,
    input_digest: &str,
    report_path: &str,
) -> Result<(), i32> {
    let report_path = absolute_input_path(Path::new(report_path)).map_err(|_| 66)?;
    let result = (|| -> Result<String, String> {
        let source_path = absolute_input_path(Path::new(source_path))?;
        let project_path = absolute_input_path(Path::new(project_path))?;
        if path_is_within(&project_path, &report_path) {
            return Err("native-toolchain-gate-report-inside-project".to_owned());
        }
        if !is_valid_digest(input_digest) {
            return Err("native-toolchain-gate-input-digest-invalid".to_owned());
        }

        let binary =
            env::current_exe().map_err(|_| "native-toolchain-gate-binary-unreadable".to_owned())?;
        let binary_metadata = fs::symlink_metadata(&binary)
            .map_err(|_| "native-toolchain-gate-binary-unreadable".to_owned())?;
        if binary_metadata.file_type().is_symlink() || !binary_metadata.is_file() {
            return Err("native-toolchain-gate-binary-not-regular".to_owned());
        }
        let binary_digest = digest_bytes(
            &fs::read(&binary).map_err(|_| "native-toolchain-gate-binary-unreadable".to_owned())?,
        );
        let dependency_scan = static_node_dependency_scan(&binary)?;
        let release_build = binary
            .components()
            .any(|component| component.as_os_str() == "release")
            && !cfg!(debug_assertions);
        if !release_build {
            return Err("native-toolchain-gate-release-binary-required".to_owned());
        }

        let direct_source_bytes = fs::read(&source_path)
            .map_err(|_| "native-toolchain-gate-source-unreadable".to_owned())?;
        let direct_graph = read_graph_source_quiet(&direct_source_bytes, "direct-source")?;
        let direct_canonical =
            serialize_canonical_graph(&direct_graph).map_err(|error| error.code.to_owned())?;
        let project = load_project_directory(&project_path).map_err(|error| error.code)?;
        let project_module = project
            .modules
            .iter()
            .find(|module| module.name == module_name)
            .ok_or_else(|| "native-toolchain-gate-module-missing".to_owned())?;
        let project_source_path = project_path.join(&project_module.path);
        let project_source_bytes = fs::read(&project_source_path)
            .map_err(|_| "native-toolchain-gate-project-source-unreadable".to_owned())?;
        let project_graph = read_graph_source_quiet(&project_source_bytes, &project_module.path)?;
        let project_canonical =
            serialize_canonical_graph(&project_graph).map_err(|error| error.code.to_owned())?;
        if direct_canonical != project_canonical {
            return Err("native-toolchain-gate-source-project-mismatch".to_owned());
        }
        let direct_graph_revision =
            graph_revision(&direct_graph).map_err(|error| error.code.to_owned())?;
        let project_graph_revision =
            graph_revision(&project_graph).map_err(|error| error.code.to_owned())?;
        if direct_graph_revision != project_graph_revision {
            return Err("native-toolchain-gate-graph-revision-mismatch".to_owned());
        }

        let root = native_temp_root("toolchain-gate");
        let empty_path = root.join("empty-path");
        let direct_workspace = root.join("direct");
        let project_workspace = root.join("project");
        fs::create_dir_all(&empty_path)
            .and_then(|_| fs::create_dir_all(&direct_workspace))
            .and_then(|_| fs::create_dir_all(&project_workspace))
            .map_err(|_| "native-toolchain-gate-temporary-directory-failure".to_owned())?;

        let gate_result = (|| -> Result<String, String> {
            let mut process_count = 0;
            let direct_check = run_native_command(
                &binary,
                &empty_path,
                &direct_workspace,
                &[
                    "check".to_owned(),
                    source_path.to_string_lossy().into_owned(),
                ],
                &mut process_count,
            )?;
            require_success("direct-check", &direct_check)?;

            let direct_canonical_result = run_native_command(
                &binary,
                &empty_path,
                &direct_workspace,
                &[
                    "canonical".to_owned(),
                    source_path.to_string_lossy().into_owned(),
                ],
                &mut process_count,
            )?;
            require_success("direct-canonical", &direct_canonical_result)?;
            if direct_canonical_result.stdout != direct_canonical.as_bytes() {
                return Err("native-toolchain-gate-canonical-drift".to_owned());
            }

            let translated = run_native_command(
                &binary,
                &empty_path,
                &direct_workspace,
                &[
                    "translate".to_owned(),
                    source_path.to_string_lossy().into_owned(),
                ],
                &mut process_count,
            )?;
            require_success("direct-translate", &translated)?;
            let translated_artifact = translated.stdout;
            let translated_artifact_path = direct_workspace.join("translated.rebc");
            write_atomic(&translated_artifact_path, &translated_artifact)
                .map_err(|_| "native-toolchain-gate-artifact-write-failure".to_owned())?;

            let compiled_artifact_path = direct_workspace.join("compiled.rebc");
            let compiled = run_native_command(
                &binary,
                &empty_path,
                &direct_workspace,
                &[
                    "compile".to_owned(),
                    source_path.to_string_lossy().into_owned(),
                    compiled_artifact_path.to_string_lossy().into_owned(),
                ],
                &mut process_count,
            )?;
            require_success("direct-compile", &compiled)?;
            let compiled_artifact = fs::read(&compiled_artifact_path)
                .map_err(|_| "native-toolchain-gate-artifact-unreadable".to_owned())?;
            if compiled_artifact != translated_artifact {
                return Err("native-toolchain-gate-artifact-drift".to_owned());
            }

            let verified = run_native_command(
                &binary,
                &empty_path,
                &direct_workspace,
                &[
                    "verify".to_owned(),
                    source_path.to_string_lossy().into_owned(),
                    compiled_artifact_path.to_string_lossy().into_owned(),
                ],
                &mut process_count,
            )?;
            require_success("direct-verify", &verified)?;

            let direct_run = run_native_command(
                &binary,
                &empty_path,
                &direct_workspace,
                &[
                    "run".to_owned(),
                    source_path.to_string_lossy().into_owned(),
                    compiled_artifact_path.to_string_lossy().into_owned(),
                    input_digest.to_owned(),
                ],
                &mut process_count,
            )?;
            require_success("direct-run", &direct_run)?;

            let developer_report_path = project_workspace.join("developer-gate.json");
            let developer_gate = run_native_command(
                &binary,
                &empty_path,
                &project_workspace,
                &[
                    "developer-gate".to_owned(),
                    project_path.to_string_lossy().into_owned(),
                    module_name.to_owned(),
                    input_digest.to_owned(),
                    developer_report_path.to_string_lossy().into_owned(),
                ],
                &mut process_count,
            )?;
            require_success("developer-gate", &developer_gate)?;
            let developer_report = fs::read(&developer_report_path)
                .map_err(|_| "native-toolchain-gate-developer-report-unreadable".to_owned())?;
            if developer_report != developer_gate.stdout {
                return Err("native-toolchain-gate-developer-report-drift".to_owned());
            }

            let value = JsonValue::Object(vec![
                (
                    "binary_dependency_scan".to_owned(),
                    JsonValue::String(dependency_scan),
                ),
                (
                    "binary_digest".to_owned(),
                    JsonValue::String(binary_digest.clone()),
                ),
                (
                    "debug_build".to_owned(),
                    JsonValue::Bool(cfg!(debug_assertions)),
                ),
                (
                    "direct_canonical_digest".to_owned(),
                    JsonValue::String(digest_bytes(&direct_canonical_result.stdout)),
                ),
                (
                    "direct_check_digest".to_owned(),
                    JsonValue::String(digest_bytes(&direct_check.stdout)),
                ),
                (
                    "direct_compile_digest".to_owned(),
                    JsonValue::String(digest_bytes(&compiled_artifact)),
                ),
                (
                    "direct_compile_result_digest".to_owned(),
                    JsonValue::String(digest_bytes(&compiled.stdout)),
                ),
                (
                    "direct_run_digest".to_owned(),
                    JsonValue::String(digest_bytes(&direct_run.stdout)),
                ),
                (
                    "direct_translate_digest".to_owned(),
                    JsonValue::String(digest_bytes(&translated_artifact)),
                ),
                (
                    "direct_verify_digest".to_owned(),
                    JsonValue::String(digest_bytes(&verified.stdout)),
                ),
                (
                    "developer_gate_digest".to_owned(),
                    JsonValue::String(digest_bytes(&developer_gate.stdout)),
                ),
                (
                    "graph_revision".to_owned(),
                    JsonValue::String(direct_graph_revision.clone()),
                ),
                (
                    "input_digest".to_owned(),
                    JsonValue::String(input_digest.to_owned()),
                ),
                (
                    "module".to_owned(),
                    JsonValue::String(module_name.to_owned()),
                ),
                (
                    "profile_digest".to_owned(),
                    JsonValue::String(PROJECT_INIT_PROFILE_DIGEST.to_owned()),
                ),
                (
                    "project_digest".to_owned(),
                    JsonValue::String(project.project_digest.clone()),
                ),
                (
                    "project_semantic_digest".to_owned(),
                    JsonValue::String(digest_bytes(project_canonical.as_bytes())),
                ),
                ("release_build".to_owned(), JsonValue::Bool(release_build)),
                ("reproducible".to_owned(), JsonValue::Bool(true)),
                (
                    "schema".to_owned(),
                    JsonValue::String(TOOLCHAIN_GATE_SCHEMA.to_owned()),
                ),
                (
                    "source_digest".to_owned(),
                    JsonValue::String(digest_bytes(&direct_source_bytes)),
                ),
                (
                    "source_semantic_digest".to_owned(),
                    JsonValue::String(digest_bytes(direct_canonical.as_bytes())),
                ),
                ("status".to_owned(), JsonValue::String("passed".to_owned())),
                (
                    "toolchain_digest".to_owned(),
                    JsonValue::String(PROJECT_INIT_TOOLCHAIN_DIGEST.to_owned()),
                ),
            ]);
            let report_digest = digest_bytes(canonicalize(&value).as_bytes());
            let JsonValue::Object(mut fields) = value else {
                unreachable!();
            };
            fields.push(("report_digest".to_owned(), JsonValue::String(report_digest)));
            Ok(format!("{}\n", canonicalize(&JsonValue::Object(fields))))
        })();
        fs::remove_dir_all(&root).ok();
        gate_result
    })();

    match result {
        Ok(report) => {
            if write_atomic(&report_path, report.as_bytes()).is_err() {
                eprintln!("native-toolchain-gate-report-write-failure");
                return Err(74);
            }
            print!("{report}");
            Ok(())
        }
        Err(code) => {
            eprintln!("{code}");
            Err(if code.ends_with("report-write-failure") {
                74
            } else {
                65
            })
        }
    }
}

fn require_developer_stage(command: &str, result: &NativeCommandResult) -> Result<(), String> {
    if result.exit_code == 0 && result.stderr.is_empty() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&result.stderr).trim().to_owned();
    if !stderr.is_empty() {
        Err(stderr)
    } else {
        let stdout = String::from_utf8_lossy(&result.stdout).trim().to_owned();
        if stdout.is_empty() {
            Err(format!("native-developer-gate-{command}-failed"))
        } else {
            Err(stdout)
        }
    }
}

fn digest_bytes(bytes: &[u8]) -> String {
    format!("sha256:{}", sha256_hex(bytes))
}

fn is_valid_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn absolute_input_path(path: &Path) -> Result<PathBuf, String> {
    if path.is_absolute() {
        return Ok(path.to_path_buf());
    }
    env::current_dir()
        .map(|directory| directory.join(path))
        .map_err(|_| "node-free-source-unreadable".to_owned())
}

fn normalized_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::RootDir | Component::Prefix(_) | Component::Normal(_) => {
                normalized.push(component.as_os_str());
            }
        }
    }
    normalized
}

fn path_is_within(parent: &Path, child: &Path) -> bool {
    let parent = normalized_path(parent);
    let child = normalized_path(child);
    child.starts_with(&parent) && child != parent
}

fn path_is_inside_or_equal(parent: &Path, child: &Path) -> bool {
    let parent = normalized_path(parent);
    let child = normalized_path(child);
    child.starts_with(&parent)
}

fn build_node_free_report(
    source_path: &Path,
    project_path: &Path,
    module_name: &str,
) -> Result<NodeFreeReport, String> {
    let binary = env::current_exe().map_err(|_| "node-free-binary-unreadable".to_owned())?;
    let binary_metadata =
        fs::symlink_metadata(&binary).map_err(|_| "node-free-binary-unreadable".to_owned())?;
    if !binary_metadata.file_type().is_file() {
        return Err("node-free-binary-not-regular".to_owned());
    }
    let binary_bytes = fs::read(&binary).map_err(|_| "node-free-binary-unreadable".to_owned())?;
    let binary_digest = format!("sha256:{}", sha256_hex(&binary_bytes));
    let dependency_scan = static_node_dependency_scan(&binary)?;
    let source_js_file_count =
        inspect_isolation(source_path)?.saturating_add(inspect_isolation(project_path)?);
    if source_js_file_count != 0 {
        return Err("node-free-javascript-isolation-failed".to_owned());
    }
    let source_inventory_digest = source_inventory_digest(source_path, project_path)?;
    let empty_path = make_empty_path()?;
    let root = empty_path
        .parent()
        .ok_or_else(|| "node-free-temporary-directory-failure".to_owned())?
        .to_path_buf();
    let profile_digest = format!(
        "sha256:{}",
        sha256_hex(b"re.native-node-free-profile@0.1.0")
    );
    let toolchain_digest = format!(
        "sha256:{}",
        sha256_hex(b"re.native-rust-std-toolchain@0.1.0")
    );
    let input_digest = format!("sha256:{}", sha256_hex(b"re.native-node-free-input@0.1.0"));
    let mut process_count = 0u32;
    let mut expected_workloads: Option<Vec<NativeWorkloadEvidence>> = None;
    let mut samples = Vec::with_capacity(3);
    for round in 0..3u32 {
        let round_root = root.join(format!("round-{round}"));
        fs::create_dir_all(&round_root)
            .map_err(|_| "node-free-temporary-directory-failure".to_owned())?;
        let (workloads, sample) = run_node_free_round(
            &binary,
            &empty_path,
            source_path,
            project_path,
            module_name,
            &round_root,
            &profile_digest,
            &toolchain_digest,
            &input_digest,
            &mut process_count,
            round,
        )?;
        if let Some(expected) = &expected_workloads {
            if expected != &workloads {
                return Err("node-free-semantic-mismatch".to_owned());
            }
        } else {
            expected_workloads = Some(workloads);
        }
        samples.push(sample);
    }
    let workloads =
        expected_workloads.ok_or_else(|| "node-free-workload-set-invalid".to_owned())?;
    let mut report = NodeFreeReport {
        benchmark_schema: NODE_FREE_BENCHMARK_SCHEMA.to_owned(),
        binary_digest,
        candidate_status: vec![
            NativeCandidate::measured("native", 3),
            NativeCandidate::pending("go", "not-measured"),
            NativeCandidate::pending("jvm", "not-measured"),
            NativeCandidate::pending("node", "migration-oracle-only"),
        ],
        dependency_scan,
        evidence_digest: String::new(),
        node_import_count: 0,
        node_load_count: 0,
        node_process_count: 0,
        performance_eligible: false,
        process_count,
        profile_digest,
        production_claim: false,
        release_build: binary
            .components()
            .any(|component| component.as_os_str() == "release"),
        report_schema: NODE_FREE_REPORT_SCHEMA.to_owned(),
        samples,
        semantic_mismatch_count: 0,
        source_inventory_digest,
        source_js_file_count,
        stable_digest: String::new(),
        stable_v1_claim: false,
        toolchain_digest,
        workloads,
    };
    for sample in &mut report.samples {
        sample.semantic_digest = workload_semantic_digest(&report.workloads);
        sample.workload_digest = workload_digest(&report.workloads);
    }
    report.stable_digest = stable_digest(&report);
    report.evidence_digest = report.computed_evidence_digest();
    fs::remove_dir_all(root).ok();
    Ok(report)
}

#[allow(clippy::too_many_arguments)]
fn run_node_free_round(
    binary: &Path,
    empty_path: &Path,
    source_path: &Path,
    project_path: &Path,
    module_name: &str,
    round_root: &Path,
    profile_digest: &str,
    toolchain_digest: &str,
    input_digest: &str,
    process_count: &mut u32,
    round: u32,
) -> Result<(Vec<NativeWorkloadEvidence>, NativeSample), String> {
    let mut startup_times = Vec::with_capacity(3);
    for _ in 0..3 {
        let result = run_native_command(
            binary,
            empty_path,
            round_root,
            &["--version".to_owned()],
            process_count,
        )?;
        require_success("startup", &result)?;
        startup_times.push(result.elapsed_ns);
    }

    let artifact_path = round_root.join("artifact.rebc");
    let cold_cache = round_root.join("cache");
    let cold_build = round_root.join("build");
    fs::create_dir_all(&cold_cache)
        .map_err(|_| "node-free-temporary-directory-failure".to_owned())?;
    fs::create_dir_all(&cold_build)
        .map_err(|_| "node-free-temporary-directory-failure".to_owned())?;
    let mut workloads = Vec::with_capacity(14);

    let result = run_native_command(
        binary,
        empty_path,
        round_root,
        &[
            "check".to_owned(),
            source_path.to_string_lossy().into_owned(),
        ],
        process_count,
    )?;
    workloads.push(evidence("check", &result)?);

    let result = run_native_command(
        binary,
        empty_path,
        round_root,
        &[
            "translate".to_owned(),
            source_path.to_string_lossy().into_owned(),
        ],
        process_count,
    )?;
    let direct_translate_ns = result.elapsed_ns;
    require_success("translate", &result)?;
    fs::write(&artifact_path, &result.stdout)
        .map_err(|_| "node-free-artifact-write-failure".to_owned())?;
    workloads.push(evidence("translate", &result)?);

    let result = run_native_command(
        binary,
        empty_path,
        round_root,
        &[
            "run".to_owned(),
            source_path.to_string_lossy().into_owned(),
            artifact_path.to_string_lossy().into_owned(),
            input_digest.to_owned(),
        ],
        process_count,
    )?;
    let direct_run_ns = result.elapsed_ns;
    workloads.push(evidence("run", &result)?);

    let initialized_project = round_root.join("initialized-project");
    let result = run_native_command(
        binary,
        empty_path,
        round_root,
        &[
            "project-init".to_owned(),
            initialized_project.to_string_lossy().into_owned(),
        ],
        process_count,
    )?;
    workloads.push(evidence("project-init", &result)?);

    let result = run_native_command(
        binary,
        empty_path,
        round_root,
        &[
            "project-check".to_owned(),
            project_path.to_string_lossy().into_owned(),
        ],
        process_count,
    )?;
    workloads.push(evidence("project-check", &result)?);

    let result = run_native_command(
        binary,
        empty_path,
        round_root,
        &[
            "project-test".to_owned(),
            initialized_project.to_string_lossy().into_owned(),
        ],
        process_count,
    )?;
    workloads.push(evidence("project-test", &result)?);

    let build_args = vec![
        "project-build".to_owned(),
        project_path.to_string_lossy().into_owned(),
        cold_cache.to_string_lossy().into_owned(),
        cold_build.to_string_lossy().into_owned(),
        profile_digest.to_owned(),
        toolchain_digest.to_owned(),
    ];
    let cold = run_native_command(binary, empty_path, round_root, &build_args, process_count)?;
    let cold_build_ns = cold.elapsed_ns;
    workloads.push(evidence("project-build", &cold)?);
    let warm = run_native_command(binary, empty_path, round_root, &build_args, process_count)?;
    require_success("project-build-warm", &warm)?;
    let warm_build_ns = warm.elapsed_ns;

    let result = run_native_command(
        binary,
        empty_path,
        round_root,
        &[
            "project-translate".to_owned(),
            project_path.to_string_lossy().into_owned(),
            cold_cache.to_string_lossy().into_owned(),
            cold_build.to_string_lossy().into_owned(),
            profile_digest.to_owned(),
            toolchain_digest.to_owned(),
            module_name.to_owned(),
        ],
        process_count,
    )?;
    let project_translate_ns = result.elapsed_ns;
    workloads.push(evidence("project-translate", &result)?);

    let result = run_native_command(
        binary,
        empty_path,
        round_root,
        &[
            "project-run".to_owned(),
            project_path.to_string_lossy().into_owned(),
            cold_cache.to_string_lossy().into_owned(),
            cold_build.to_string_lossy().into_owned(),
            profile_digest.to_owned(),
            toolchain_digest.to_owned(),
            module_name.to_owned(),
            input_digest.to_owned(),
        ],
        process_count,
    )?;
    let project_run_ns = result.elapsed_ns;
    workloads.push(evidence("project-run", &result)?);

    let mut server_times = Vec::with_capacity(3);
    let mut first_server: Option<NativeWorkloadEvidence> = None;
    for _ in 0..3 {
        let result = run_native_command(
            binary,
            empty_path,
            round_root,
            &["server-smoke".to_owned()],
            process_count,
        )?;
        let current = evidence("server-smoke", &result)?;
        if let Some(first) = &first_server {
            if first != &current {
                return Err("node-free-semantic-mismatch".to_owned());
            }
        } else {
            first_server = Some(current);
        }
        server_times.push(result.elapsed_ns);
    }
    workloads.push(first_server.ok_or_else(|| "node-free-workload-invalid".to_owned())?);

    let mut project_server_times = Vec::with_capacity(3);
    let mut first_project_server: Option<NativeWorkloadEvidence> = None;
    for _ in 0..3 {
        let result = run_native_command(
            binary,
            empty_path,
            round_root,
            &[
                "project-server-smoke".to_owned(),
                project_path.to_string_lossy().into_owned(),
                module_name.to_owned(),
                profile_digest.to_owned(),
                toolchain_digest.to_owned(),
                input_digest.to_owned(),
            ],
            process_count,
        )?;
        let current = evidence("project-server-smoke", &result)?;
        if let Some(first) = &first_project_server {
            if first != &current {
                return Err("node-free-semantic-mismatch".to_owned());
            }
        } else {
            first_project_server = Some(current);
        }
        project_server_times.push(result.elapsed_ns);
    }
    workloads.push(first_project_server.ok_or_else(|| "node-free-workload-invalid".to_owned())?);

    let execution_plan = NativeProjectExecutionPlan::new(module_name, "main", Vec::new());
    let plan_path = round_root.join("execution-plan.json");
    let execution_cache_path = round_root.join("execution-cache.json");
    let plan_source =
        serialize_project_execution_plan(&execution_plan).map_err(|error| error.code)?;
    fs::write(&plan_path, plan_source.as_bytes())
        .map_err(|_| "node-free-temporary-directory-failure".to_owned())?;
    let result = run_native_command(
        binary,
        empty_path,
        round_root,
        &[
            "project-execute-plan".to_owned(),
            project_path.to_string_lossy().into_owned(),
            plan_path.to_string_lossy().into_owned(),
            profile_digest.to_owned(),
            toolchain_digest.to_owned(),
            input_digest.to_owned(),
        ],
        process_count,
    )?;
    workloads.push(evidence("project-execute-plan", &result)?);
    let direct = run_native_command(
        binary,
        empty_path,
        round_root,
        &[
            "project-execute-plan-direct".to_owned(),
            project_path.to_string_lossy().into_owned(),
            plan_path.to_string_lossy().into_owned(),
            profile_digest.to_owned(),
            toolchain_digest.to_owned(),
            input_digest.to_owned(),
        ],
        process_count,
    )?;
    if direct.stdout != result.stdout {
        return Err("node-free-semantic-mismatch".to_owned());
    }
    workloads.push(evidence("project-execute-plan-direct", &direct)?);
    let first_cached = run_native_command(
        binary,
        empty_path,
        round_root,
        &[
            "project-execute-plan-cached".to_owned(),
            project_path.to_string_lossy().into_owned(),
            plan_path.to_string_lossy().into_owned(),
            execution_cache_path.to_string_lossy().into_owned(),
            profile_digest.to_owned(),
            toolchain_digest.to_owned(),
            input_digest.to_owned(),
        ],
        process_count,
    )?;
    let second_cached = run_native_command(
        binary,
        empty_path,
        round_root,
        &[
            "project-execute-plan-cached".to_owned(),
            project_path.to_string_lossy().into_owned(),
            plan_path.to_string_lossy().into_owned(),
            execution_cache_path.to_string_lossy().into_owned(),
            profile_digest.to_owned(),
            toolchain_digest.to_owned(),
            input_digest.to_owned(),
        ],
        process_count,
    )?;
    if first_cached.stdout != second_cached.stdout {
        return Err("node-free-semantic-mismatch".to_owned());
    }
    workloads.push(evidence("project-execute-plan-cached", &first_cached)?);

    let mut rss = current_rss_bytes()?;
    rss = rss.max(current_rss_bytes()?);
    server_times.sort_unstable();
    startup_times.sort_unstable();
    let startup_ns = quantile(&startup_times, 50);
    let p50_ns = quantile(&server_times, 50);
    let p95_ns = quantile(&server_times, 95);
    let p99_ns = quantile(&server_times, 99);
    let throughput_ops_per_sec_milli = 3u128
        .saturating_mul(1_000_000_000_000)
        .checked_div(server_times.iter().sum::<u128>().max(1))
        .unwrap_or(0);
    let sample = NativeSample {
        adapter_overhead_ns: p50_ns.saturating_sub(startup_ns),
        cold_build_ns,
        p50_ns,
        p95_ns,
        p99_ns,
        peak_rss_bytes: rss,
        project_overhead_ns: project_translate_ns
            .saturating_add(project_run_ns)
            .saturating_sub(direct_translate_ns.saturating_add(direct_run_ns)),
        round,
        semantic_digest: String::new(),
        startup_ns,
        throughput_ops_per_sec_milli,
        warm_build_ns,
        workload_digest: String::new(),
    };
    Ok((workloads, sample))
}

struct NativeCommandResult {
    elapsed_ns: u128,
    exit_code: i32,
    stderr: Vec<u8>,
    stdout: Vec<u8>,
}

fn run_native_command(
    binary: &Path,
    empty_path: &Path,
    cwd: &Path,
    arguments: &[String],
    process_count: &mut u32,
) -> Result<NativeCommandResult, String> {
    *process_count = process_count.saturating_add(1);
    let started = Instant::now();
    let mut command = process::Command::new(binary);
    command.args(arguments);
    configure_empty_path_command(&mut command, empty_path);
    let output = command
        .current_dir(cwd)
        .output()
        .map_err(|_| "node-free-native-process-failure".to_owned())?;
    Ok(NativeCommandResult {
        elapsed_ns: started.elapsed().as_nanos().max(1),
        exit_code: output.status.code().unwrap_or(-1),
        stderr: output.stderr,
        stdout: output.stdout,
    })
}

fn configure_empty_path_command(command: &mut process::Command, empty_path: &Path) {
    command.env_clear().env("PATH", empty_path);
    #[cfg(target_os = "windows")]
    for variable in [
        "SystemRoot",
        "windir",
        "SystemDrive",
        "ComSpec",
        "TEMP",
        "TMP",
    ] {
        if let Some(value) = env::var_os(variable) {
            command.env(variable, value);
        }
    }
}

fn require_success(command: &str, result: &NativeCommandResult) -> Result<(), String> {
    if result.exit_code != 0 || !result.stderr.is_empty() {
        let detail = [&result.stdout, &result.stderr]
            .iter()
            .find_map(|bytes| stable_diagnostic_code(bytes));
        return Err(match detail {
            Some(code) => format!("node-free-workload-failed-{command}-{code}"),
            None => format!("node-free-workload-failed-{command}"),
        });
    }
    Ok(())
}

fn stable_diagnostic_code(bytes: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(bytes).ok()?;
    let marker = "\"code\":\"";
    let start = text.find(marker)?.saturating_add(marker.len());
    let end = text[start..].find('"')?.saturating_add(start);
    let code = &text[start..end];
    if code.is_empty()
        || !code.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"-_.".contains(&byte)
        })
    {
        return None;
    }
    Some(code.to_owned())
}

fn evidence(command: &str, result: &NativeCommandResult) -> Result<NativeWorkloadEvidence, String> {
    require_success(command, result)?;
    let digest = format!("sha256:{}", sha256_hex(&result.stdout));
    Ok(NativeWorkloadEvidence {
        command: command.to_owned(),
        exit_code: result.exit_code,
        output_digest: digest.clone(),
        semantic_digest: digest,
        status: "passed".to_owned(),
    })
}

fn quantile(values: &[u128], percentile: u128) -> u128 {
    let index = ((values.len().saturating_sub(1) as u128)
        .saturating_mul(percentile)
        .saturating_add(99)
        / 100) as usize;
    values[index.min(values.len().saturating_sub(1))]
}

fn make_empty_path() -> Result<PathBuf, String> {
    let root = native_temp_root("node-free");
    fs::create_dir_all(&root).map_err(|_| "node-free-temporary-directory-failure".to_owned())?;
    let empty = root.join("empty-path");
    fs::create_dir_all(&empty).map_err(|_| "node-free-temporary-directory-failure".to_owned())?;
    Ok(empty)
}

fn inspect_isolation(path: &Path) -> Result<u32, String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| "node-free-source-unreadable".to_owned())?;
    if metadata.file_type().is_symlink() {
        return Err("node-free-source-symlink".to_owned());
    }
    if metadata.is_file() {
        return Ok(forbidden_source_file(path) as u32);
    }
    if !metadata.is_dir() {
        return Err("node-free-source-not-regular".to_owned());
    }
    let mut entries = fs::read_dir(path)
        .map_err(|_| "node-free-source-unreadable".to_owned())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "node-free-source-unreadable".to_owned())?;
    entries.sort_by_key(|left| left.file_name());
    let mut count = 0u32;
    for entry in entries {
        count = count.saturating_add(inspect_isolation(&entry.path())?);
    }
    Ok(count)
}

fn forbidden_source_file(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    matches!(extension.as_str(), "js" | "mjs" | "cjs" | "map")
        || is_dependency_directory_name(name.as_bytes())
        || name == "package-lock.json"
        || name == "pnpm-lock.yaml"
        || name == "yarn.lock"
}

fn is_dependency_directory_name(bytes: &[u8]) -> bool {
    bytes.len() == 12
        && bytes[0] == 110
        && bytes[1] == 111
        && bytes[2] == 100
        && bytes[3] == 101
        && bytes[4] == 95
        && bytes[5] == 109
        && bytes[6] == 111
        && bytes[7] == 100
        && bytes[8] == 117
        && bytes[9] == 108
        && bytes[10] == 101
        && bytes[11] == 115
}

fn source_inventory_digest(source_path: &Path, project_path: &Path) -> Result<String, String> {
    let mut entries = Vec::new();
    collect_inventory(source_path, "source", &mut entries)?;
    collect_inventory(project_path, "project", &mut entries)?;
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    let mut bytes = Vec::new();
    for (label, content) in entries {
        bytes.extend_from_slice(label.as_bytes());
        bytes.push(0);
        bytes.extend_from_slice(&(content.len() as u64).to_be_bytes());
        bytes.extend_from_slice(&content);
    }
    Ok(format!("sha256:{}", sha256_hex(&bytes)))
}

fn collect_inventory(
    path: &Path,
    label: &str,
    output: &mut Vec<(String, Vec<u8>)>,
) -> Result<(), String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| "node-free-source-unreadable".to_owned())?;
    if metadata.file_type().is_symlink() {
        return Err("node-free-source-symlink".to_owned());
    }
    if metadata.is_file() {
        output.push((
            label.to_owned(),
            fs::read(path).map_err(|_| "node-free-source-unreadable".to_owned())?,
        ));
        return Ok(());
    }
    if !metadata.is_dir() {
        return Err("node-free-source-not-regular".to_owned());
    }
    let mut entries = fs::read_dir(path)
        .map_err(|_| "node-free-source-unreadable".to_owned())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "node-free-source-unreadable".to_owned())?;
    entries.sort_by_key(|left| left.file_name());
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        collect_inventory(&entry.path(), &format!("{label}/{name}"), output)?;
    }
    Ok(())
}

fn static_node_dependency_scan(binary: &Path) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    let (tool, arguments, label): (&str, Vec<String>, &str) = (
        "/usr/bin/otool",
        vec!["-L".to_owned(), binary.to_string_lossy().into_owned()],
        "otool-L",
    );
    #[cfg(target_os = "linux")]
    let (tool, arguments, label): (&str, Vec<String>, &str) = (
        "/usr/bin/ldd",
        vec![binary.to_string_lossy().into_owned()],
        "ldd",
    );
    #[cfg(target_os = "windows")]
    let (tool, arguments, label): (&str, Vec<String>, &str) =
        ("", Vec::new(), "windows-static-boundary");
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    let (tool, arguments, label): (&str, Vec<String>, &str) =
        ("", Vec::new(), "unsupported-platform-static-boundary");

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let _ = binary;

    if tool.is_empty() {
        return Ok(label.to_owned());
    }
    let output = process::Command::new(tool)
        .args(arguments)
        .env_clear()
        .output()
        .map_err(|_| "node-free-dependency-scan-failure".to_owned())?;
    if !output.status.success() {
        return Err("node-free-dependency-scan-failure".to_owned());
    }
    let text = String::from_utf8_lossy(&output.stdout).to_ascii_lowercase();
    if text.lines().skip(1).any(|line| {
        line.contains("node")
            || line.contains("npm")
            || line.contains(".js")
            || line.contains("libnode")
    }) {
        return Err("node-free-node-dependency-found".to_owned());
    }
    Ok(label.to_owned())
}

fn current_rss_bytes() -> Result<u64, String> {
    #[cfg(target_os = "macos")]
    {
        let output = process::Command::new("/bin/ps")
            .args(["-o", "rss=", "-p", &process::id().to_string()])
            .env_clear()
            .output()
            .map_err(|_| "node-free-rss-unavailable".to_owned())?;
        let kilobytes = String::from_utf8_lossy(&output.stdout)
            .trim()
            .parse::<u64>()
            .map_err(|_| "node-free-rss-unavailable".to_owned())?;
        return Ok(kilobytes.saturating_mul(1024).max(1));
    }
    #[cfg(target_os = "linux")]
    {
        let status = fs::read_to_string("/proc/self/status")
            .map_err(|_| "node-free-rss-unavailable".to_owned())?;
        let kilobytes = status
            .lines()
            .find_map(|line| line.strip_prefix("VmRSS:")?.split_whitespace().next())
            .and_then(|value| value.parse::<u64>().ok())
            .ok_or_else(|| "node-free-rss-unavailable".to_owned())?;
        return Ok(kilobytes.saturating_mul(1024).max(1));
    }
    #[cfg(target_os = "windows")]
    {
        #[repr(C)]
        struct ProcessMemoryCounters {
            cb: u32,
            page_fault_count: u32,
            peak_working_set_size: usize,
            working_set_size: usize,
            quota_peak_paged_pool_usage: usize,
            quota_paged_pool_usage: usize,
            quota_peak_non_paged_pool_usage: usize,
            quota_non_paged_pool_usage: usize,
            pagefile_usage: usize,
            peak_pagefile_usage: usize,
        }

        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetCurrentProcess() -> *mut c_void;
        }

        #[link(name = "psapi")]
        unsafe extern "system" {
            fn GetProcessMemoryInfo(
                process: *mut c_void,
                counters: *mut ProcessMemoryCounters,
                size: u32,
            ) -> i32;
        }

        let mut counters = ProcessMemoryCounters {
            cb: std::mem::size_of::<ProcessMemoryCounters>() as u32,
            page_fault_count: 0,
            peak_working_set_size: 0,
            working_set_size: 0,
            quota_peak_paged_pool_usage: 0,
            quota_paged_pool_usage: 0,
            quota_peak_non_paged_pool_usage: 0,
            quota_non_paged_pool_usage: 0,
            pagefile_usage: 0,
            peak_pagefile_usage: 0,
        };
        let success =
            unsafe { GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, counters.cb) };
        if success == 0 {
            return Err("node-free-rss-unavailable".to_owned());
        }
        return Ok(counters.working_set_size.max(1) as u64);
    }
    #[allow(unreachable_code)]
    Err("node-free-rss-unavailable".to_owned())
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), ()> {
    let temporary = path.with_extension(format!("{}.tmp", process::id()));
    if fs::write(&temporary, bytes).is_err() {
        return Err(());
    }
    if fs::rename(&temporary, path).is_err() {
        fs::remove_file(&temporary).ok();
        return Err(());
    }
    Ok(())
}

struct CliHealthHandler;

impl HttpHandler for CliHealthHandler {
    fn handle(
        &mut self,
        route_id: &str,
        _request: &HttpRequest,
    ) -> Result<HttpResponse, ServerError> {
        if route_id != "health" {
            return Err(ServerError::RouteNotFound);
        }
        Ok(HttpResponse::new(
            200,
            std::collections::BTreeMap::from([(
                "content-type".to_owned(),
                "application/json".to_owned(),
            )]),
            b"{\"status\":\"ok\"}".to_vec(),
        ))
    }
}

struct StaticJsonHandler {
    body: Vec<u8>,
}

impl HttpHandler for StaticJsonHandler {
    fn handle(
        &mut self,
        route_id: &str,
        request: &HttpRequest,
    ) -> Result<HttpResponse, ServerError> {
        if route_id != "project-run" || request.method != "GET" || request.path != "/run" {
            return Err(ServerError::RouteNotFound);
        }
        if !request.body.is_empty() {
            return Err(ServerError::InvalidRequest);
        }
        Ok(HttpResponse::new(
            200,
            BTreeMap::from([("content-type".to_owned(), "application/json".to_owned())]),
            self.body.clone(),
        ))
    }
}

struct ProjectRunHandler {
    project_path: String,
    workspace: PathBuf,
    module_name: String,
    profile_digest: String,
    toolchain_digest: String,
    input_digest: String,
    error_code: Option<String>,
}

impl HttpHandler for ProjectRunHandler {
    fn handle(
        &mut self,
        route_id: &str,
        request: &HttpRequest,
    ) -> Result<HttpResponse, ServerError> {
        if route_id != "project-run" || request.method != "GET" || request.path != "/run" {
            self.error_code = Some("native-project-server-route-mismatch".to_owned());
            return Err(ServerError::RouteNotFound);
        }
        if !request.body.is_empty() {
            self.error_code = Some("native-project-server-body-not-allowed".to_owned());
            return Err(ServerError::InvalidRequest);
        }

        let translation = translate_project_module(
            &self.project_path,
            self.workspace.join("cache"),
            self.workspace.join("build"),
            &self.profile_digest,
            &self.toolchain_digest,
            &self.module_name,
        )
        .map_err(|error| {
            self.error_code = Some(error.code);
            ServerError::InvalidRequest
        })?;
        let (mut bridge, _program_stdout) = project_host_bridge(
            &self.project_path,
            std::slice::from_ref(&self.module_name),
            &self.input_digest,
        )
        .map_err(|code| {
            self.error_code = Some(code);
            ServerError::InvalidRequest
        })?;
        let run = execute_project_module(
            &self.project_path,
            self.workspace.join("cache"),
            self.workspace.join("build"),
            &self.profile_digest,
            &self.toolchain_digest,
            &self.module_name,
            &translation,
            &self.input_digest,
            &mut bridge,
            VmLimits::default(),
        )
        .map_err(|error| {
            self.error_code = Some(error.code);
            ServerError::InvalidRequest
        })?;
        let body = serialize_project_run(&run)
            .map_err(|error| {
                self.error_code = Some(error.code);
                ServerError::InvalidRequest
            })?
            .into_bytes();
        Ok(HttpResponse::new(
            200,
            std::collections::BTreeMap::from([(
                "content-type".to_owned(),
                "application/json".to_owned(),
            )]),
            body,
        ))
    }
}

fn check(path: &str) -> Result<(), i32> {
    let (source, file) = read_source(path)?;
    if source.starts_with("re 0.1 canonical\n") {
        let graph = load_canonical_graph(&source).map_err(|error| {
            print_graph_error(&error);
            65
        })?;
        let statement_count = graph
            .functions
            .iter()
            .map(|function| function.statements.len())
            .sum::<usize>();
        println!(
            "{{\"capability_count\":{},\"ok\":true,\"schema\":{},\"statement_count\":{},\"token_count\":0,\"unit\":{}}}",
            graph.capabilities.len(),
            quote(CHECK_SCHEMA),
            statement_count,
            quote(&graph.unit),
        );
        return Ok(());
    }
    match parse_source(&source, &file) {
        Ok(program) => {
            println!(
                "{{\"capability_count\":{},\"ok\":true,\"schema\":{},\"statement_count\":{},\"token_count\":{},\"unit\":{}}}",
                program.capabilities.len(),
                quote(CHECK_SCHEMA),
                program.statement_count,
                program.tokens.len(),
                quote(&program.unit),
            );
            Ok(())
        }
        Err(diagnostic) => {
            println!(
                "{{\"diagnostics\":[{}],\"ok\":false,\"schema\":{}}}",
                diagnostic.to_json(),
                quote(CHECK_SCHEMA)
            );
            Err(65)
        }
    }
}

fn lex(path: &str) -> Result<(), i32> {
    let (source, file) = read_source(path)?;
    match tokenize_source(&source, &file) {
        Ok(tokens) => {
            let rendered = tokens.iter().map(token_json).collect::<Vec<_>>().join(",");
            println!(
                "{{\"ok\":true,\"schema\":{},\"tokens\":[{}]}}",
                quote(LEX_SCHEMA),
                rendered
            );
            Ok(())
        }
        Err(diagnostic) => {
            println!(
                "{{\"diagnostics\":[{}],\"ok\":false,\"schema\":{}}}",
                diagnostic.to_json(),
                quote(LEX_SCHEMA)
            );
            Err(65)
        }
    }
}

fn digest(path: &str) -> Result<(), i32> {
    let bytes = fs::read(path).map_err(|_| 66)?;
    println!("sha256:{}", sha256_hex(&bytes));
    Ok(())
}

fn canonical(path: &str) -> Result<(), i32> {
    let bytes = fs::read(path).map_err(|_| 66)?;
    let source = SourceText::from_bytes(&bytes, path).map_err(|diagnostic| {
        print_simple_graph_error(diagnostic.code.as_str());
        65
    })?;
    let graph = if source.text.starts_with("re 0.1 canonical\n") {
        load_canonical_graph(&source.text)
    } else {
        parse_compact_graph(&source.text, path).and_then(check_graph)
    }
    .map_err(|error| {
        print_graph_error(&error);
        65
    })?;
    let rendered = serialize_canonical_graph(&graph).map_err(|error| {
        print_graph_error(&error);
        65
    })?;
    print!("{rendered}");
    Ok(())
}

fn manifest(path: &str) -> Result<(), i32> {
    let graph = read_graph(path)?;
    let review = review_manifest(&graph).map_err(|error| {
        print_graph_error(&error);
        65
    })?;
    println!(
        "{{\"executed\":[],\"execution_evidence\":{},\"graph_revision\":{},\"reachable\":[{}],\"schema\":{},\"uid_anchors\":[{}],\"unit\":{}}}",
        quote(&review.execution_evidence),
        quote(&graph_revision(&graph).map_err(|_| 65)?),
        review
            .reachable
            .iter()
            .map(|value| quote(value))
            .collect::<Vec<_>>()
            .join(","),
        quote(&review.schema),
        review
            .uid_anchors
            .iter()
            .map(|value| quote(value))
            .collect::<Vec<_>>()
            .join(","),
        quote(&review.unit),
    );
    Ok(())
}

fn translate(path: &str) -> Result<(), i32> {
    let graph = read_graph(path)?;
    let artifact = translate_graph(&graph).map_err(|error| {
        print_graph_error(&error);
        65
    })?;
    let bytes = serialize_bytecode_artifact(&artifact).map_err(|error| {
        print_graph_error(&error);
        65
    })?;
    print!("{bytes}");
    Ok(())
}

fn project_check(path: &str) -> Result<(), i32> {
    let project = load_project_directory(path).map_err(|error| {
        print_project_error(&error.code);
        65
    })?;
    let graph = serialize_project_graph(&project).map_err(|error| {
        print_project_error(&error.code);
        65
    })?;
    print!("{graph}");
    Ok(())
}

fn project_init(path: &str) -> Result<(), i32> {
    let target = Path::new(path);
    let target_exists = match fs::symlink_metadata(target) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            print_project_error("project-init-target-symlink");
            return Err(65);
        }
        Ok(metadata) if !metadata.is_dir() => {
            print_project_error("project-init-target-not-directory");
            return Err(65);
        }
        Ok(_) => {
            let mut entries = fs::read_dir(target).map_err(|_| {
                print_project_error("project-init-target-unreadable");
                65
            })?;
            if entries.next().is_some() {
                print_project_error("project-init-target-not-empty");
                return Err(65);
            }
            true
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => {
            print_project_error("project-init-target-unreadable");
            return Err(65);
        }
    };

    let source_digest = format!("sha256:{}", sha256_hex(PROJECT_INIT_SOURCE.as_bytes()));
    let contract_digest = format!(
        "sha256:{}",
        sha256_hex(b"revia.app.main.main:process.status@0.1.0")
    );
    let package = NativePackage::new(
        "revia.app",
        vec![NativeModule::new(
            "revia.app.main",
            source_digest.clone(),
            NativeInterface::new(
                "revia.app.main",
                Vec::new(),
                vec![NativeExport::function("main", contract_digest)],
            ),
        )],
    );
    let manifest = serialize_project_manifest(
        &[NativeProjectModule::new(
            "revia.app.main",
            "modules/main.re",
            source_digest,
        )],
        &package,
    )
    .map_err(|_| {
        print_project_error("project-init-manifest-invalid");
        65
    })?;

    let created_root = !target_exists;
    if !target_exists && fs::create_dir_all(target).is_err() {
        print_project_error("project-init-create-failure");
        return Err(74);
    }
    let modules = target.join("modules");
    let source_path = modules.join("main.re");
    let manifest_path = target.join("project.json");
    let result = (|| {
        fs::create_dir(&modules).map_err(|_| "project-init-create-failure")?;
        write_atomic(&source_path, PROJECT_INIT_SOURCE.as_bytes())
            .map_err(|_| "project-init-write-failure")?;
        write_atomic(&manifest_path, manifest.as_bytes())
            .map_err(|_| "project-init-write-failure")?;
        Ok::<(), &str>(())
    })();
    if let Err(code) = result {
        if created_root {
            let _ = fs::remove_dir_all(target);
        } else {
            let _ = fs::remove_file(&source_path);
            let _ = fs::remove_file(&manifest_path);
            let _ = fs::remove_dir(&modules);
        }
        print_project_error(code);
        return Err(if code == "project-init-write-failure" {
            74
        } else {
            65
        });
    }

    println!(
        "{{\"module\":{},\"ok\":true,\"schema\":{}}}",
        quote("revia.app.main"),
        quote("re.native-project-init@0.1.0"),
    );
    Ok(())
}

fn project_test(path: &str) -> Result<(), i32> {
    let project = load_project_directory(path).map_err(|error| {
        print_project_error(&error.code);
        65
    })?;
    let workspace = temporary_project_workspace("test")?;
    let result = (|| {
        let mut modules = Vec::with_capacity(project.modules.len());
        for module in &project.modules {
            let translation = translate_project_module(
                path,
                workspace.join("cache"),
                workspace.join("build"),
                PROJECT_INIT_PROFILE_DIGEST,
                PROJECT_INIT_TOOLCHAIN_DIGEST,
                &module.name,
            )
            .map_err(|error| error.code)?;
            modules.push(JsonValue::Object(vec![
                (
                    "artifact_digest".to_owned(),
                    JsonValue::String(translation.artifact_digest),
                ),
                ("module".to_owned(), JsonValue::String(translation.module)),
                (
                    "translation_digest".to_owned(),
                    JsonValue::String(translation.translation_digest),
                ),
            ]));
        }
        let value = JsonValue::Object(vec![
            (
                "graph_revision".to_owned(),
                JsonValue::String(project.graph_revision),
            ),
            ("modules".to_owned(), JsonValue::Array(modules)),
            (
                "project_digest".to_owned(),
                JsonValue::String(project.project_digest),
            ),
            ("ok".to_owned(), JsonValue::Bool(true)),
            (
                "schema".to_owned(),
                JsonValue::String(PROJECT_TEST_SCHEMA.to_owned()),
            ),
        ]);
        Ok::<String, String>(format!("{}\n", canonicalize(&value)))
    })();
    fs::remove_dir_all(&workspace).ok();
    match result {
        Ok(output) => {
            print!("{output}");
            Ok(())
        }
        Err(code) => {
            print_project_error(&code);
            Err(65)
        }
    }
}

fn project_scale(path: &str) -> Result<(), i32> {
    let project = load_project_directory(path).map_err(|error| {
        print_project_error(&error.code);
        65
    })?;
    let report = validate_enterprise_project_scale(&project).map_err(|error| {
        print_project_error(&error.code);
        65
    })?;
    println!(
        "{{\"graph_revision\":{},\"module_count\":{},\"public_symbol_count\":{},\"route_count\":{},\"schema\":{},\"summary_digest\":{},\"task_count\":{}}}",
        quote(&report.graph_revision),
        report.module_count,
        report.public_symbol_count,
        report.route_count,
        quote(&report.schema),
        quote(&report.summary_digest),
        report.task_count,
    );
    Ok(())
}

fn project_execute_plan(
    project_path: &str,
    plan_path: &str,
    profile_digest: &str,
    toolchain_digest: &str,
    input_digest: &str,
) -> Result<(), i32> {
    let plan_source = fs::read_to_string(plan_path).map_err(|_| 66)?;
    let plan = parse_project_execution_plan(&plan_source).map_err(|error| {
        print_project_runtime_error(&error.code);
        65
    })?;
    let workspace = temporary_project_workspace("execution-plan")?;
    let (mut bridge, _program_stdout) = project_host_bridge(
        project_path,
        &plan
            .steps
            .iter()
            .map(|step| step.module.clone())
            .chain(std::iter::once(plan.module.clone()))
            .collect::<Vec<_>>(),
        input_digest,
    )
    .map_err(|code| {
        print_project_runtime_error(&code);
        65
    })?;
    let result = execute_project_execution_plan(
        project_path,
        workspace.join("cache"),
        workspace.join("build"),
        profile_digest,
        toolchain_digest,
        &plan,
        input_digest,
        &mut bridge,
        VmLimits::default(),
    )
    .and_then(|execution| {
        serialize_project_execution(&execution).inspect_err(|error| {
            print_project_runtime_error(&error.code);
        })
    })
    .map(|output| print!("{output}"))
    .map_err(|error| {
        if error.code.is_empty() {
            print_project_runtime_error("native-project-execution-failure");
        } else {
            print_project_runtime_error(&error.code);
        }
        65
    });
    fs::remove_dir_all(&workspace).ok();
    result
}

fn project_execute_plan_direct(
    project_path: &str,
    plan_path: &str,
    profile_digest: &str,
    toolchain_digest: &str,
    input_digest: &str,
) -> Result<(), i32> {
    let plan_source = fs::read_to_string(plan_path).map_err(|_| 66)?;
    let plan = parse_project_execution_plan(&plan_source).map_err(|error| {
        print_project_runtime_error(&error.code);
        65
    })?;
    let workspace = temporary_project_workspace("execution-plan-direct")?;
    let (mut bridge, _program_stdout) = project_host_bridge(
        project_path,
        &plan
            .steps
            .iter()
            .map(|step| step.module.clone())
            .chain(std::iter::once(plan.module.clone()))
            .collect::<Vec<_>>(),
        input_digest,
    )
    .map_err(|code| {
        print_project_runtime_error(&code);
        65
    })?;
    let result = execute_project_execution_plan_direct(
        project_path,
        workspace.join("cache"),
        workspace.join("build"),
        profile_digest,
        toolchain_digest,
        &plan,
        input_digest,
        &mut bridge,
        VmLimits::default(),
    )
    .and_then(|execution| {
        serialize_project_execution(&execution).inspect_err(|error| {
            print_project_runtime_error(&error.code);
        })
    })
    .map(|output| print!("{output}"))
    .map_err(|error| {
        if error.code.is_empty() {
            print_project_runtime_error("native-project-execution-direct-failure");
        } else {
            print_project_runtime_error(&error.code);
        }
        65
    });
    fs::remove_dir_all(&workspace).ok();
    result
}

fn project_execute_plan_cached(
    project_path: &str,
    plan_path: &str,
    execution_cache_path: &str,
    profile_digest: &str,
    toolchain_digest: &str,
    input_digest: &str,
) -> Result<(), i32> {
    let plan_source = fs::read_to_string(plan_path).map_err(|_| 66)?;
    let plan = parse_project_execution_plan(&plan_source).map_err(|error| {
        eprint_project_runtime_error(&error.code);
        65
    })?;
    let (mut bridge, _program_stdout) = project_host_bridge(
        project_path,
        &plan
            .steps
            .iter()
            .map(|step| step.module.clone())
            .chain(std::iter::once(plan.module.clone()))
            .collect::<Vec<_>>(),
        input_digest,
    )
    .map_err(|code| {
        eprint_project_runtime_error(&code);
        65
    })?;
    let cache_path = Path::new(execution_cache_path);
    let cache_directory = cache_path.with_extension("module-cache");
    let build_directory = cache_path.with_extension("build");
    execute_project_execution_plan_cached(
        project_path,
        &cache_directory,
        &build_directory,
        execution_cache_path,
        profile_digest,
        toolchain_digest,
        &plan,
        input_digest,
        &mut bridge,
        VmLimits::default(),
    )
    .and_then(|cached| {
        serialize_project_execution(&cached.execution).inspect_err(|error| {
            eprint_project_runtime_error(&error.code);
        })
    })
    .map(|output| print!("{output}"))
    .map_err(|error| {
        if error.code.is_empty() {
            eprint_project_runtime_error("native-project-execution-cache-failure");
        } else {
            eprint_project_runtime_error(&error.code);
        }
        65
    })
}

fn project_multi_module_gate(
    project_path: &str,
    plan_path: &str,
    profile_digest: &str,
    toolchain_digest: &str,
    input_digest: &str,
    report_path: &str,
) -> Result<(), i32> {
    let plan_source = fs::read_to_string(plan_path).map_err(|_| 66)?;
    let plan = parse_project_execution_plan(&plan_source).map_err(|error| {
        print_project_runtime_error(&error.code);
        65
    })?;
    let workspace = temporary_project_workspace("multi-module-gate")?;
    let result = (|| {
        let module_names = plan
            .steps
            .iter()
            .map(|step| step.module.clone())
            .chain(std::iter::once(plan.module.clone()))
            .collect::<Vec<_>>();
        let (mut bridge, _program_stdout) =
            project_host_bridge(project_path, &module_names, input_digest).map_err(|code| {
                print_project_runtime_error(&code);
                65
            })?;
        let report = execute_native_multi_module_gate(
            project_path,
            workspace.join("cache"),
            workspace.join("build"),
            profile_digest,
            toolchain_digest,
            &plan,
            input_digest,
            &mut bridge,
            VmLimits::default(),
        )
        .map_err(|error| {
            print_project_runtime_error(&error.code);
            65
        })?;
        let output = serialize_native_multi_module_gate_report(&report).map_err(|error| {
            print_project_runtime_error(&error.code);
            65
        })?;
        if write_atomic(Path::new(report_path), output.as_bytes()).is_err() {
            print_project_runtime_error("native-multi-module-gate-write-failure");
            return Err(74);
        }
        print!("{output}");
        Ok(())
    })();
    fs::remove_dir_all(&workspace).ok();
    result
}

#[allow(clippy::too_many_arguments)]
fn project_server_gate(
    project_path: &str,
    plan_path: &str,
    profile_digest: &str,
    toolchain_digest: &str,
    input_digest: &str,
    sqlite_executable: &str,
    database_path: &str,
    report_path: &str,
) -> Result<(), i32> {
    let project_path = absolute_input_path(Path::new(project_path)).map_err(|_| 66)?;
    let plan_path = absolute_input_path(Path::new(plan_path)).map_err(|_| 66)?;
    let database_path = absolute_input_path(Path::new(database_path)).map_err(|_| 66)?;
    let report_path = absolute_input_path(Path::new(report_path)).map_err(|_| 66)?;
    let (sqlite_executable, sqlite_executable_digest) =
        resolve_sqlite_executable(sqlite_executable).map_err(|code| {
            print_project_runtime_error(&code);
            65
        })?;
    if path_is_inside_or_equal(&project_path, &database_path)
        || path_is_inside_or_equal(&project_path, &report_path)
    {
        eprintln!("native-project-server-gate-output-inside-project");
        return Err(65);
    }
    let plan_source = fs::read_to_string(&plan_path).map_err(|_| 66)?;
    let plan = parse_project_execution_plan(&plan_source).map_err(|error| {
        print_project_runtime_error(&error.code);
        65
    })?;
    let workspace = temporary_project_workspace("server-gate")?;
    let result = (|| -> Result<String, i32> {
        let module_names = plan
            .steps
            .iter()
            .map(|step| step.module.clone())
            .chain(std::iter::once(plan.module.clone()))
            .collect::<Vec<_>>();
        let (mut bridge, program_stdout) =
            project_host_bridge(project_path.to_str().unwrap(), &module_names, input_digest)
                .map_err(|code| {
                    print_project_runtime_error(&code);
                    65
                })?;
        let multi_module = execute_native_multi_module_gate(
            &project_path,
            workspace.join("cache"),
            workspace.join("build"),
            profile_digest,
            toolchain_digest,
            &plan,
            input_digest,
            &mut bridge,
            VmLimits::default(),
        )
        .map_err(|error| {
            print_project_runtime_error(&error.code);
            65
        })?;
        let program_stdout = program_stdout.snapshot().map_err(|_| {
            print_project_runtime_error("native-project-server-gate-stdout-unavailable");
            65
        })?;
        let program_stdout = String::from_utf8(program_stdout).map_err(|_| {
            print_project_runtime_error("native-project-server-gate-stdout-invalid");
            65
        })?;

        let response_value = JsonValue::Object(vec![
            (
                "execution_digest".to_owned(),
                JsonValue::String(multi_module.execution.execution_digest.clone()),
            ),
            (
                "program_stdout".to_owned(),
                JsonValue::String(program_stdout),
            ),
            (
                "project_digest".to_owned(),
                JsonValue::String(multi_module.project_digest.clone()),
            ),
            (
                "status".to_owned(),
                JsonValue::Number(
                    multi_module
                        .execution
                        .steps
                        .last()
                        .ok_or_else(|| {
                            print_project_runtime_error(
                                "native-project-server-gate-execution-empty",
                            );
                            65
                        })?
                        .vm
                        .outcome
                        .code
                        .to_string(),
                ),
            ),
        ]);
        let mut schemas = JsonSchemaRegistry::new();
        schemas
            .register(
                NATIVE_PROJECT_SERVER_RESPONSE_SCHEMA,
                JsonSchema::object(BTreeMap::from([
                    ("execution_digest".to_owned(), JsonKind::String),
                    ("program_stdout".to_owned(), JsonKind::String),
                    ("project_digest".to_owned(), JsonKind::String),
                    ("status".to_owned(), JsonKind::Number),
                ])),
            )
            .map_err(|_| 70)?;
        let json_body = schemas
            .encode(NATIVE_PROJECT_SERVER_RESPONSE_SCHEMA, &response_value)
            .map_err(|_| {
                print_project_runtime_error("native-project-server-gate-json-schema-failure");
                65
            })?;

        let statements = vec![
            SqlStatement::new(
                "CREATE TABLE IF NOT EXISTS revia_server_gate (execution_digest TEXT NOT NULL, project_digest TEXT NOT NULL)",
                vec![],
            )
            .map_err(|_| 65)?,
            SqlStatement::new("DELETE FROM revia_server_gate", vec![]).map_err(|_| 65)?,
            SqlStatement::new(
                "INSERT INTO revia_server_gate (execution_digest, project_digest) VALUES (@p0, @p1)",
                vec![
                    SqlValue::Text(multi_module.execution.execution_digest.clone()),
                    SqlValue::Text(multi_module.project_digest.clone()),
                ],
            )
            .map_err(|_| 65)?,
        ];
        let sqlite =
            SqliteCliDriver::new(database_path.clone(), sqlite_executable).map_err(|_| {
                print_project_runtime_error("native-project-server-gate-database-invalid");
                65
            })?;
        let transaction = sqlite.transaction(&statements).map_err(|error| {
            print_project_runtime_error(&format!("native-project-server-gate-sql-{:?}", error));
            65
        })?;
        let rows = sqlite
            .query(
                "SELECT execution_digest, project_digest FROM revia_server_gate WHERE execution_digest = @p0",
                &[SqlValue::Text(
                    multi_module.execution.execution_digest.clone(),
                )],
            )
            .map_err(|_| {
                print_project_runtime_error("native-project-server-gate-query-failure");
                65
            })?;
        if rows.len() != 1 {
            print_project_runtime_error("native-project-server-gate-query-cardinality");
            return Err(65);
        }
        let database_value = JsonValue::Array(
            rows.iter()
                .map(|row| {
                    JsonValue::Object(
                        row.iter()
                            .map(|(key, value)| {
                                let value = match value {
                                    SqlValue::Text(value) => JsonValue::String(value.clone()),
                                    SqlValue::Integer(value) => {
                                        JsonValue::Number(value.to_string())
                                    }
                                };
                                (key.clone(), value)
                            })
                            .collect(),
                    )
                })
                .collect(),
        );
        let database_json = canonicalize(&database_value);
        let module_evidence_json = canonicalize(&JsonValue::Array(
            multi_module
                .modules
                .iter()
                .map(|module| {
                    JsonValue::Object(vec![
                        (
                            "artifact_digest".to_owned(),
                            JsonValue::String(module.artifact_digest.clone()),
                        ),
                        (
                            "contract_digest".to_owned(),
                            JsonValue::String(module.contract_digest.clone()),
                        ),
                        (
                            "implementation_digest".to_owned(),
                            JsonValue::String(module.implementation_digest.clone()),
                        ),
                        (
                            "interface_digest".to_owned(),
                            JsonValue::String(module.interface_digest.clone()),
                        ),
                        (
                            "module".to_owned(),
                            JsonValue::String(module.module.clone()),
                        ),
                        (
                            "source_sha256".to_owned(),
                            JsonValue::String(module.source_sha256.clone()),
                        ),
                        (
                            "translation_digest".to_owned(),
                            JsonValue::String(module.translation_digest.clone()),
                        ),
                    ])
                })
                .collect(),
        ));
        let statement_json = canonicalize(&JsonValue::Array(
            statements
                .iter()
                .map(|statement| JsonValue::String(statement.sql.clone()))
                .collect(),
        ));
        let parameter_json = canonicalize(&JsonValue::Array(vec![
            JsonValue::String(multi_module.execution.execution_digest.clone()),
            JsonValue::String(multi_module.project_digest.clone()),
        ]));
        let request = b"GET /run HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n".to_vec();
        let limits = HttpLimits::new(32 * 1024, 16 * 1024, 32 * 1024).map_err(|_| {
            print_project_runtime_error("native-project-server-gate-http-limits-invalid");
            70
        })?;
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|_| {
            print_project_runtime_error("native-project-server-gate-listener-bind-failure");
            70
        })?;
        let address = listener.local_addr().map_err(|_| {
            print_project_runtime_error("native-project-server-gate-listener-address-failure");
            70
        })?;
        let router = HttpRouter::new(vec![
            HttpRoute::new("GET", "/run", "project-run").map_err(|_| 70)?,
        ])
        .map_err(|_| {
            print_project_runtime_error("native-project-server-gate-route-invalid");
            70
        })?;
        let cancellation = ServerCancellation::new();
        let response_body = json_body.as_bytes().to_vec();
        let server = thread::spawn(move || {
            let mut handler = StaticJsonHandler {
                body: response_body,
            };
            serve_once(&listener, &router, &mut handler, &limits, &cancellation)
        });
        let mut client = TcpStream::connect(address).map_err(|_| {
            print_project_runtime_error("native-project-server-gate-client-connect-failure");
            70
        })?;
        client.write_all(&request).map_err(|_| {
            print_project_runtime_error("native-project-server-gate-client-write-failure");
            70
        })?;
        client
            .set_read_timeout(Some(std::time::Duration::from_secs(2)))
            .map_err(|_| {
                print_project_runtime_error("native-project-server-gate-client-timeout-failure");
                70
            })?;
        let mut raw_response = Vec::new();
        client.read_to_end(&mut raw_response).map_err(|_| {
            print_project_runtime_error("native-project-server-gate-client-read-failure");
            70
        })?;
        let receipt = server
            .join()
            .map_err(|_| {
                print_project_runtime_error("native-project-server-gate-server-panic");
                70
            })?
            .map_err(|_| {
                print_project_runtime_error("native-project-server-gate-server-failure");
                70
            })?;
        if receipt.route_id != "project-run" || receipt.status != 200 {
            print_project_runtime_error("native-project-server-gate-route-mismatch");
            return Err(65);
        }
        let raw_response_text = String::from_utf8(raw_response.clone()).map_err(|_| 65)?;
        let response_body_text = raw_response_text
            .split_once("\r\n\r\n")
            .map(|(_, body)| body)
            .ok_or(65)?;
        let decoded = schemas
            .decode(NATIVE_PROJECT_SERVER_RESPONSE_SCHEMA, response_body_text)
            .map_err(|_| 65)?;
        if canonicalize(&decoded) != json_body {
            print_project_runtime_error("native-project-server-gate-response-drift");
            return Err(65);
        }
        let mut report = NativeProjectServerGateReport {
            build_manifest_digest: multi_module.build_manifest_digest,
            database_result_digest: digest_bytes(database_json.as_bytes()),
            graph_revision: multi_module.graph_revision,
            http_request_digest: digest_bytes(&request),
            http_response_digest: digest_bytes(&raw_response),
            http_status: receipt.status,
            input_digest: multi_module.input_digest,
            json_response_digest: digest_bytes(json_body.as_bytes()),
            json_schema: NATIVE_PROJECT_SERVER_RESPONSE_SCHEMA.to_owned(),
            module_count: multi_module.modules.len(),
            module_evidence_digest: digest_bytes(module_evidence_json.as_bytes()),
            multi_module_gate_digest: multi_module.gate_digest,
            plan_digest: multi_module.plan_digest,
            profile_digest: multi_module.profile_digest,
            project_digest: multi_module.project_digest,
            report_digest: String::new(),
            route_id: receipt.route_id,
            schema: NATIVE_PROJECT_SERVER_GATE_SCHEMA.to_owned(),
            sqlite_executable_digest,
            sql_parameter_digest: digest_bytes(parameter_json.as_bytes()),
            sql_statement_digest: digest_bytes(statement_json.as_bytes()),
            toolchain_digest: multi_module.toolchain_digest,
            transaction_affected_rows: transaction.affected_rows,
        };
        report.report_digest = server_gate_report_digest(&report).map_err(|error| {
            print_project_runtime_error(&error.code);
            65
        })?;
        let output = serialize_native_project_server_gate_report(&report).map_err(|error| {
            print_project_runtime_error(&error.code);
            65
        })?;
        write_atomic(&report_path, output.as_bytes()).map_err(|_| {
            print_project_runtime_error("native-project-server-gate-write-failure");
            74
        })?;
        Ok(output)
    })();
    fs::remove_dir_all(&workspace).ok();
    result.map(|output| print!("{output}"))
}

fn project_execute(
    project_path: &str,
    module_name: &str,
    profile_digest: &str,
    toolchain_digest: &str,
    input_digest: &str,
) -> Result<(), i32> {
    let workspace = temporary_project_workspace("execute")?;
    let result = execute_project_once(
        project_path,
        &workspace,
        profile_digest,
        toolchain_digest,
        module_name,
        input_digest,
    )
    .map(|(_, output)| {
        print!("{output}");
    });
    fs::remove_dir_all(&workspace).ok();
    result
}

fn project_benchmark(
    project_path: &str,
    module_name: &str,
    profile_digest: &str,
    toolchain_digest: &str,
    input_digest: &str,
    report_path: &str,
) -> Result<(), i32> {
    let workspace = temporary_project_workspace("benchmark")?;
    let result = (|| {
        let mut samples = Vec::with_capacity(3);
        let mut project_digest = None;
        let mut graph_revision = None;
        for round in 0..3u64 {
            let started = Instant::now();
            let (run, output) = execute_project_once(
                project_path,
                &workspace,
                profile_digest,
                toolchain_digest,
                module_name,
                input_digest,
            )?;
            project_digest.get_or_insert_with(|| run.project_digest.clone());
            graph_revision.get_or_insert_with(|| run.graph_revision.clone());
            samples.push(ProjectBenchmarkSample {
                elapsed_ns: started.elapsed().as_nanos().max(1),
                output_digest: format!("sha256:{}", sha256_hex(output.as_bytes())),
                round,
                run_digest: run.run_digest,
            });
        }
        let report = serialize_project_benchmark(
            project_digest.as_deref().ok_or(65)?,
            graph_revision.as_deref().ok_or(65)?,
            module_name,
            profile_digest,
            toolchain_digest,
            input_digest,
            &samples,
        );
        if write_atomic(Path::new(report_path), report.as_bytes()).is_err() {
            print_project_benchmark_error("native-project-benchmark-write-failure");
            return Err(74);
        }
        print!("{report}");
        Ok(())
    })();
    fs::remove_dir_all(&workspace).ok();
    result
}

fn temporary_project_workspace(label: &str) -> Result<PathBuf, i32> {
    let workspace = native_temp_root(&format!("project-{label}"));
    fs::create_dir_all(workspace.join("cache")).map_err(|_| 74)?;
    fs::create_dir_all(workspace.join("build")).map_err(|_| 74)?;
    Ok(workspace)
}

fn execute_project_once(
    project_path: &str,
    workspace: &Path,
    profile_digest: &str,
    toolchain_digest: &str,
    module_name: &str,
    input_digest: &str,
) -> Result<(revia_core::project_runtime::NativeProjectRun, String), i32> {
    let translation = translate_project_module(
        project_path,
        workspace.join("cache"),
        workspace.join("build"),
        profile_digest,
        toolchain_digest,
        module_name,
    )
    .map_err(|error| {
        print_project_runtime_error(&error.code);
        65
    })?;
    let (mut bridge, _program_stdout) = project_host_bridge(
        project_path,
        std::slice::from_ref(&module_name.to_owned()),
        input_digest,
    )
    .map_err(|code| {
        print_project_runtime_error(&code);
        65
    })?;
    let run = execute_project_module(
        project_path,
        workspace.join("cache"),
        workspace.join("build"),
        profile_digest,
        toolchain_digest,
        module_name,
        &translation,
        input_digest,
        &mut bridge,
        VmLimits::default(),
    )
    .map_err(|error| {
        print_project_runtime_error(&error.code);
        65
    })?;
    let output = serialize_project_run(&run).map_err(|error| {
        print_project_runtime_error(&error.code);
        65
    })?;
    Ok((run, output))
}

struct ProjectBenchmarkSample {
    elapsed_ns: u128,
    output_digest: String,
    round: u64,
    run_digest: String,
}

fn serialize_project_benchmark(
    project_digest: &str,
    graph_revision: &str,
    module_name: &str,
    profile_digest: &str,
    toolchain_digest: &str,
    input_digest: &str,
    samples: &[ProjectBenchmarkSample],
) -> String {
    let stable_runs = samples
        .iter()
        .map(|sample| {
            JsonValue::Object(vec![
                (
                    "output_digest".to_owned(),
                    JsonValue::String(sample.output_digest.clone()),
                ),
                (
                    "round".to_owned(),
                    JsonValue::Number(sample.round.to_string()),
                ),
                (
                    "run_digest".to_owned(),
                    JsonValue::String(sample.run_digest.clone()),
                ),
            ])
        })
        .collect::<Vec<_>>();
    let stable = JsonValue::Object(vec![
        (
            "graph_revision".to_owned(),
            JsonValue::String(graph_revision.to_owned()),
        ),
        (
            "input_digest".to_owned(),
            JsonValue::String(input_digest.to_owned()),
        ),
        (
            "iterations".to_owned(),
            JsonValue::Number(samples.len().to_string()),
        ),
        (
            "module".to_owned(),
            JsonValue::String(module_name.to_owned()),
        ),
        (
            "project_digest".to_owned(),
            JsonValue::String(project_digest.to_owned()),
        ),
        (
            "profile_digest".to_owned(),
            JsonValue::String(profile_digest.to_owned()),
        ),
        ("runs".to_owned(), JsonValue::Array(stable_runs)),
        (
            "schema".to_owned(),
            JsonValue::String(PROJECT_BENCHMARK_SCHEMA.to_owned()),
        ),
        (
            "toolchain_digest".to_owned(),
            JsonValue::String(toolchain_digest.to_owned()),
        ),
    ]);
    let stable_digest = format!("sha256:{}", sha256_hex(canonicalize(&stable).as_bytes()));
    let languages = [
        (
            "native",
            "measured",
            "native-project-execute",
            samples.len(),
        ),
        ("go", "pending", "not-measured", 0),
        ("jvm", "pending", "not-measured", 0),
        ("node", "pending", "migration-oracle-only", 0),
    ]
    .into_iter()
    .map(|(language, status, reason, sample_count)| {
        JsonValue::Object(vec![
            (
                "language".to_owned(),
                JsonValue::String(language.to_owned()),
            ),
            ("reason".to_owned(), JsonValue::String(reason.to_owned())),
            (
                "sample_count".to_owned(),
                JsonValue::Number(sample_count.to_string()),
            ),
            ("status".to_owned(), JsonValue::String(status.to_owned())),
        ])
    })
    .collect::<Vec<_>>();
    let runs = samples
        .iter()
        .map(|sample| {
            JsonValue::Object(vec![
                (
                    "elapsed_ns".to_owned(),
                    JsonValue::Number(sample.elapsed_ns.to_string()),
                ),
                (
                    "output_digest".to_owned(),
                    JsonValue::String(sample.output_digest.clone()),
                ),
                (
                    "round".to_owned(),
                    JsonValue::Number(sample.round.to_string()),
                ),
                (
                    "run_digest".to_owned(),
                    JsonValue::String(sample.run_digest.clone()),
                ),
            ])
        })
        .collect::<Vec<_>>();
    let without_report_digest = JsonValue::Object(vec![
        (
            "graph_revision".to_owned(),
            JsonValue::String(graph_revision.to_owned()),
        ),
        (
            "input_digest".to_owned(),
            JsonValue::String(input_digest.to_owned()),
        ),
        (
            "iterations".to_owned(),
            JsonValue::Number(samples.len().to_string()),
        ),
        ("languages".to_owned(), JsonValue::Array(languages)),
        (
            "module".to_owned(),
            JsonValue::String(module_name.to_owned()),
        ),
        (
            "project_digest".to_owned(),
            JsonValue::String(project_digest.to_owned()),
        ),
        (
            "profile_digest".to_owned(),
            JsonValue::String(profile_digest.to_owned()),
        ),
        ("runs".to_owned(), JsonValue::Array(runs)),
        (
            "schema".to_owned(),
            JsonValue::String(PROJECT_BENCHMARK_SCHEMA.to_owned()),
        ),
        ("stable_digest".to_owned(), JsonValue::String(stable_digest)),
        (
            "toolchain_digest".to_owned(),
            JsonValue::String(toolchain_digest.to_owned()),
        ),
    ]);
    let report_digest = format!(
        "sha256:{}",
        sha256_hex(canonicalize(&without_report_digest).as_bytes())
    );
    let mut report_fields = match without_report_digest {
        JsonValue::Object(fields) => fields,
        _ => unreachable!(),
    };
    report_fields.push(("report_digest".to_owned(), JsonValue::String(report_digest)));
    format!("{}\n", canonicalize(&JsonValue::Object(report_fields)))
}

fn project_translate(
    project_path: &str,
    cache_path: &str,
    build_path: &str,
    profile_digest: &str,
    toolchain_digest: &str,
    module_name: &str,
) -> Result<(), i32> {
    let translation = translate_project_module(
        project_path,
        cache_path,
        build_path,
        profile_digest,
        toolchain_digest,
        module_name,
    )
    .map_err(|error| {
        print_project_runtime_error(&error.code);
        65
    })?;
    let output = serialize_project_translation(&translation).map_err(|error| {
        print_project_runtime_error(&error.code);
        65
    })?;
    print!("{output}");
    Ok(())
}

fn project_run(
    project_path: &str,
    cache_path: &str,
    build_path: &str,
    profile_digest: &str,
    toolchain_digest: &str,
    module_name: &str,
    input_digest: &str,
) -> Result<(), i32> {
    let translation = translate_project_module(
        project_path,
        cache_path,
        build_path,
        profile_digest,
        toolchain_digest,
        module_name,
    )
    .map_err(|error| {
        print_project_runtime_error(&error.code);
        65
    })?;
    let (mut bridge, _program_stdout) = project_host_bridge(
        project_path,
        std::slice::from_ref(&module_name.to_owned()),
        input_digest,
    )
    .map_err(|code| {
        print_project_runtime_error(&code);
        65
    })?;
    let run = execute_project_module(
        project_path,
        cache_path,
        build_path,
        profile_digest,
        toolchain_digest,
        module_name,
        &translation,
        input_digest,
        &mut bridge,
        VmLimits::default(),
    )
    .map_err(|error| {
        print_project_runtime_error(&error.code);
        65
    })?;
    let output = serialize_project_run(&run).map_err(|error| {
        print_project_runtime_error(&error.code);
        65
    })?;
    print!("{output}");
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn project_run_sandbox(
    project_path: &str,
    cache_path: &str,
    build_path: &str,
    profile_digest: &str,
    toolchain_digest: &str,
    module_name: &str,
    input_digest: &str,
    sandbox_path: &str,
) -> Result<(), i32> {
    let translation = translate_project_module(
        project_path,
        cache_path,
        build_path,
        profile_digest,
        toolchain_digest,
        module_name,
    )
    .map_err(|error| {
        print_project_runtime_error(&error.code);
        65
    })?;
    let project_path = absolute_input_path(Path::new(project_path)).map_err(|_| 66)?;
    let sandbox_path = absolute_input_path(Path::new(sandbox_path)).map_err(|_| 66)?;
    let (mut bridge, program_stdout) = project_host_bridge_for_sandbox(
        &project_path,
        std::slice::from_ref(&module_name.to_owned()),
        input_digest,
        &sandbox_path,
    )
    .map_err(|code| {
        print_project_runtime_error(&code);
        65
    })?;
    let run = execute_project_module(
        &project_path,
        cache_path,
        build_path,
        profile_digest,
        toolchain_digest,
        module_name,
        &translation,
        input_digest,
        &mut bridge,
        VmLimits::default(),
    )
    .map_err(|error| {
        print_project_runtime_error(&error.code);
        65
    })?;
    let output = serialize_project_run(&run).map_err(|error| {
        print_project_runtime_error(&error.code);
        65
    })?;
    let program_stdout = program_stdout.snapshot().map_err(|_| {
        print_project_runtime_error("native-project-run-program-stdout-unavailable");
        65
    })?;
    let program_stdout = String::from_utf8(program_stdout).map_err(|_| {
        print_project_runtime_error("native-project-run-program-stdout-invalid");
        65
    })?;
    let run_value = parse_json(&output).map_err(|error| {
        print_project_runtime_error(&error.code);
        65
    })?;
    let observation = JsonValue::Object(vec![
        (
            "program_stdout".to_owned(),
            JsonValue::String(program_stdout),
        ),
        ("run".to_owned(), run_value),
        (
            "schema".to_owned(),
            JsonValue::String("re.native-project-run-observation@0.1.0".to_owned()),
        ),
    ]);
    println!("{}", canonicalize(&observation));
    Ok(())
}

fn project_build(
    project_path: &str,
    cache_path: &str,
    build_path: &str,
    profile_digest: &str,
    toolchain_digest: &str,
) -> Result<(), i32> {
    let result = build_project(
        project_path,
        cache_path,
        build_path,
        profile_digest,
        toolchain_digest,
        None,
    )
    .map_err(|error| {
        print_project_error(&error.code);
        65
    })?;
    let manifest = serialize_build_manifest(&result.manifest).map_err(|error| {
        print_project_error(&error.code);
        65
    })?;
    let invalidation = format!(
        "{{\"added_modules\":[{}],\"modules\":[{}],\"removed_modules\":[{}]}}",
        result
            .invalidation
            .added_modules
            .iter()
            .map(|value| quote(value))
            .collect::<Vec<_>>()
            .join(","),
        result
            .invalidation
            .modules
            .iter()
            .map(|value| quote(value))
            .collect::<Vec<_>>()
            .join(","),
        result
            .invalidation
            .removed_modules
            .iter()
            .map(|value| quote(value))
            .collect::<Vec<_>>()
            .join(","),
    );
    println!(
        "{{\"built\":{},\"hits\":{},\"invalidation\":{},\"manifest\":{},\"misses\":{},\"ok\":true,\"published\":{},\"schema\":{}}}",
        result.stats.built,
        result.stats.hits,
        invalidation,
        manifest.trim_end(),
        result.stats.misses,
        result.published,
        quote("re.native-project-build-result@0.1.0"),
    );
    Ok(())
}

fn verify(graph_path: &str, artifact_path: &str) -> Result<(), i32> {
    let graph = read_graph(graph_path)?;
    let artifact = fs::read_to_string(artifact_path).map_err(|_| 66)?;
    let verified = verify_bytecode_artifact(&graph, &artifact).map_err(|error| {
        print_graph_error(&error);
        65
    })?;
    println!(
        "{{\"artifact_digest\":{},\"graph_revision\":{},\"ok\":true,\"profile\":{},\"schema\":{}}}",
        quote(&verified.artifact_digest),
        quote(&verified.graph_revision),
        quote(&verified.profile),
        quote("re.native-bytecode-verification@0.1.0"),
    );
    Ok(())
}

fn run(graph_path: &str, artifact_path: &str, input_digest: &str) -> Result<(), i32> {
    let graph = read_graph(graph_path)?;
    let artifact = fs::read_to_string(artifact_path).map_err(|_| 66)?;
    let loaded = revia_core::bytecode::load_bytecode_artifact(&artifact).map_err(|error| {
        print_graph_error(&error);
        65
    })?;
    let request = revia_core::vm::VmRequest::new(
        revia_core::graph::graph_revision(&graph).map_err(|_| 65)?,
        loaded.artifact_digest.clone(),
        loaded.profile.clone(),
        input_digest,
    );
    let (mut bridge, program_stdout) = system_host_bridge(&graph, graph_path, input_digest)
        .map_err(|code| {
            print_host_executor_error(&code);
            65
        })?;
    let result = execute_bytecode(
        &graph,
        &artifact,
        &request,
        &mut bridge,
        VmLimits::default(),
    )
    .map_err(|error| {
        print_host_executor_error(&error.code);
        65
    })?;
    print_host_vm_result(&result, &program_stdout).map_err(|code| {
        print_host_executor_error(&code);
        65
    })?;
    Ok(())
}

const MAX_PROGRAM_STDOUT_BYTES: usize = 1_048_576;

#[derive(Clone, Default)]
struct SharedProgramStdout {
    bytes: Arc<Mutex<Vec<u8>>>,
}

impl SharedProgramStdout {
    fn snapshot(&self) -> Result<Vec<u8>, String> {
        self.bytes
            .lock()
            .map(|value| value.clone())
            .map_err(|_| "native-host-stdout-unavailable".to_owned())
    }
}

impl Write for SharedProgramStdout {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        let mut bytes = self
            .bytes
            .lock()
            .map_err(|_| std::io::Error::other("stdout lock unavailable"))?;
        if buffer.len() > MAX_PROGRAM_STDOUT_BYTES.saturating_sub(bytes.len()) {
            return Err(std::io::Error::other("stdout limit exceeded"));
        }
        bytes.extend_from_slice(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn system_host_bridge(
    graph: &revia_core::graph::Graph,
    source_path: &str,
    input_digest: &str,
) -> Result<(HostBackedBridge<SystemHost>, SharedProgramStdout), String> {
    let source = absolute_input_path(Path::new(source_path))
        .map_err(|_| "native-host-source-unreadable".to_owned())?;
    let sandbox = source
        .parent()
        .ok_or_else(|| "native-host-sandbox-invalid".to_owned())?;
    system_host_bridge_for_sandbox(graph, sandbox, input_digest)
}

fn system_host_bridge_for_sandbox(
    graph: &revia_core::graph::Graph,
    sandbox: &Path,
    input_digest: &str,
) -> Result<(HostBackedBridge<SystemHost>, SharedProgramStdout), String> {
    let stdout = SharedProgramStdout::default();
    let host = SystemHost::new_with_random_reader(
        sandbox,
        Vec::new(),
        BTreeMap::new(),
        BTreeMap::new(),
        Box::new(stdout.clone()),
        native_random_reader()?,
    )
    .map_err(|_| "native-host-initialization-failed".to_owned())?;
    let revision =
        graph_revision(graph).map_err(|_| "native-host-graph-revision-invalid".to_owned())?;
    let bridge = HostBackedBridge::new(graph, host, revision, input_digest)?;
    Ok((bridge, stdout))
}

fn project_host_bridge(
    project_path: &str,
    module_names: &[String],
    input_digest: &str,
) -> Result<(HostBackedBridge<SystemHost>, SharedProgramStdout), String> {
    let project_path = absolute_input_path(Path::new(project_path))?;
    project_host_bridge_for_sandbox(&project_path, module_names, input_digest, &project_path)
}

fn project_host_bridge_for_sandbox(
    project_path: &Path,
    module_names: &[String],
    input_digest: &str,
    sandbox: &Path,
) -> Result<(HostBackedBridge<SystemHost>, SharedProgramStdout), String> {
    if !is_valid_digest(input_digest) {
        return Err("native-vm-request-input-digest-invalid".to_owned());
    }
    let project =
        revia_core::project::load_project_directory(project_path).map_err(|error| error.code)?;
    let mut graphs = Vec::with_capacity(module_names.len());
    let mut owned_graphs = Vec::with_capacity(module_names.len());
    for module_name in module_names {
        let module = project
            .modules
            .iter()
            .find(|module| &module.name == module_name)
            .ok_or_else(|| "native-project-entry-not-found".to_owned())?;
        let source_path = project_path.join(&module.path);
        let bytes =
            fs::read(&source_path).map_err(|_| "native-project-source-unreadable".to_owned())?;
        let source =
            SourceText::from_bytes(&bytes, &module.path).map_err(|error| error.code.to_owned())?;
        let graph = if source.text.starts_with("re 0.1 canonical\n") {
            load_canonical_graph(&source.text)
        } else {
            parse_compact_graph(&source.text, &module.path).and_then(check_graph)
        }
        .map_err(|error| error.code)?;
        owned_graphs.push(graph);
    }
    for graph in &owned_graphs {
        graphs.push(graph);
    }
    let stdout = SharedProgramStdout::default();
    let host = SystemHost::new_with_random_reader(
        sandbox,
        Vec::new(),
        BTreeMap::new(),
        BTreeMap::new(),
        Box::new(stdout.clone()),
        native_random_reader()?,
    )
    .map_err(|_| "native-host-initialization-failed".to_owned())?;
    let revision = graphs
        .first()
        .ok_or_else(|| "native-project-entry-not-found".to_owned())
        .and_then(|graph| {
            graph_revision(graph).map_err(|_| "native-host-graph-revision-invalid".to_owned())
        })?;
    let bridge = HostBackedBridge::new_for_graphs(&graphs, host, revision, input_digest)?;
    Ok((bridge, stdout))
}

fn native_random_reader() -> Result<Box<dyn Read>, String> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let random = fs::File::open("/dev/urandom")
            .map_err(|_| "native-host-random-source-failure".to_owned())?;
        return Ok(Box::new(random));
    }
    #[cfg(target_os = "windows")]
    {
        return Ok(Box::new(WindowsRandom));
    }
    #[allow(unreachable_code)]
    Err("native-host-random-source-unavailable".to_owned())
}

fn print_host_vm_result(
    result: &revia_core::vm::VmResult,
    program_stdout: &SharedProgramStdout,
) -> Result<(), String> {
    let bytes = program_stdout.snapshot()?;
    let text =
        String::from_utf8(bytes).map_err(|_| "native-host-stdout-invalid-utf8".to_owned())?;
    println!(
        "{{\"artifact_digest\":{},\"executor\":{},\"graph_revision\":{},\"host_profile\":{},\"input_digest\":{},\"invocations\":[{}],\"ok\":true,\"outcome\":{{\"code\":{},\"type\":{}}},\"profile\":{},\"program_stdout\":{},\"receipt_digest\":{},\"schema\":{},\"trace\":[{}]}}",
        quote(&result.artifact_digest),
        quote(&result.executor),
        quote(&result.graph_revision),
        quote(revia_core::minimal_std::HOST_PROFILE),
        quote(&result.input_digest),
        result
            .invocations
            .iter()
            .map(|invocation| {
                format!(
                    "{{\"instance\":{},\"invocation_id\":{},\"member\":{},\"outcome\":{}}}",
                    quote(&invocation.instance),
                    quote(&invocation.invocation_id),
                    quote(&invocation.member),
                    quote(&invocation.outcome),
                )
            })
            .collect::<Vec<_>>()
            .join(","),
        result.outcome.code,
        quote(&result.outcome.type_name),
        quote(&result.profile),
        quote(&text),
        quote(&result.receipt.receipt_digest),
        quote("re.native-host-execution-result@0.1.0"),
        result
            .trace
            .iter()
            .map(|entry| format!(
                "{{\"operation\":{},\"pc\":{}}}",
                quote(&entry.operation),
                entry.pc
            ))
            .collect::<Vec<_>>()
            .join(","),
    );
    Ok(())
}

fn print_vm_result(result: &revia_core::vm::VmResult) {
    println!(
        "{{\"artifact_digest\":{},\"executor\":{},\"graph_revision\":{},\"input_digest\":{},\"invocations\":[{}],\"ok\":true,\"outcome\":{{\"code\":{},\"type\":{}}},\"profile\":{},\"receipt_digest\":{},\"schema\":{},\"trace\":[{}]}}",
        quote(&result.artifact_digest),
        quote(&result.executor),
        quote(&result.graph_revision),
        quote(&result.input_digest),
        result
            .invocations
            .iter()
            .map(|invocation| {
                format!(
                    "{{\"instance\":{},\"invocation_id\":{},\"member\":{},\"outcome\":{}}}",
                    quote(&invocation.instance),
                    quote(&invocation.invocation_id),
                    quote(&invocation.member),
                    quote(&invocation.outcome),
                )
            })
            .collect::<Vec<_>>()
            .join(","),
        result.outcome.code,
        quote(&result.outcome.type_name),
        quote(&result.profile),
        quote(&result.receipt.receipt_digest),
        quote(&result.schema),
        result
            .trace
            .iter()
            .map(|entry| format!(
                "{{\"operation\":{},\"pc\":{}}}",
                quote(&entry.operation),
                entry.pc
            ))
            .collect::<Vec<_>>()
            .join(","),
    );
}

fn read_graph(path: &str) -> Result<revia_core::graph::Graph, i32> {
    let bytes = fs::read(path).map_err(|_| 66)?;
    let source = SourceText::from_bytes(&bytes, path).map_err(|diagnostic| {
        print_simple_graph_error(diagnostic.code.as_str());
        65
    })?;
    if source.text.starts_with("re 0.1 canonical\n") {
        load_canonical_graph(&source.text)
    } else {
        parse_compact_graph(&source.text, path).and_then(check_graph)
    }
    .map_err(|error| {
        print_graph_error(&error);
        65
    })
}

fn read_graph_quiet(path: &str) -> Result<revia_core::graph::Graph, String> {
    let bytes = fs::read(path).map_err(|_| "native-replay-source-unreadable".to_owned())?;
    read_graph_source_quiet(&bytes, path)
}

fn read_graph_source_quiet(bytes: &[u8], path: &str) -> Result<revia_core::graph::Graph, String> {
    let source =
        SourceText::from_bytes(bytes, path).map_err(|diagnostic| diagnostic.code.to_owned())?;
    if source.text.starts_with("re 0.1 canonical\n") {
        load_canonical_graph(&source.text)
    } else {
        parse_compact_graph(&source.text, path).and_then(check_graph)
    }
    .map_err(|error| error.code)
}

fn print_graph_error(error: &revia_core::graph::GraphError) {
    let mut fields = vec![format!("\"code\":{}", quote(&error.code))];
    if let Some(actual) = &error.actual {
        fields.push(format!("\"actual\":{}", quote(actual)));
    }
    if let Some(expected) = &error.expected {
        fields.push(format!("\"expected\":{}", quote(expected)));
    }
    println!(
        "{{\"diagnostics\":[{{{}}}],\"ok\":false,\"schema\":{}}}",
        fields.join(","),
        quote("re.native-graph-result@0.1.0"),
    );
}

fn print_simple_graph_error(code: &str) {
    println!(
        "{{\"diagnostics\":[{{\"code\":{}}}],\"ok\":false,\"schema\":{}}}",
        quote(code),
        quote("re.native-graph-result@0.1.0"),
    );
}

fn print_conformance_error(code: &str) {
    eprintln!(
        "{{\"diagnostics\":[{{\"code\":{}}}],\"ok\":false,\"schema\":{}}}",
        quote(code),
        quote("re.native-vm-replay-result@0.1.0"),
    );
}

fn print_cross_language_error(code: &str) {
    eprintln!(
        "{{\"diagnostics\":[{{\"code\":{}}}],\"ok\":false,\"schema\":{}}}",
        quote(code),
        quote("re.cross-language-replay-matrix@0.1.0"),
    );
}

fn print_replay_catalog_error(code: &str) {
    eprintln!(
        "{{\"diagnostics\":[{{\"code\":{}}}],\"ok\":false,\"schema\":{}}}",
        quote(code),
        quote("re.native-replay-workload-report@0.1.0"),
    );
}

fn print_replay_fault_catalog_error(code: &str) {
    eprintln!(
        "{{\"diagnostics\":[{{\"code\":{}}}],\"ok\":false,\"schema\":{}}}",
        quote(code),
        quote("re.native-replay-fault-report@0.1.0"),
    );
}

fn print_native_fault_corpus_error(code: &str) {
    eprintln!(
        "{{\"diagnostics\":[{{\"code\":{}}}],\"ok\":false,\"schema\":{}}}",
        quote(code),
        quote("re.native-fault-observation-report@0.1.0"),
    );
}

fn print_native_fault_release_error(code: &str) {
    eprintln!(
        "{{\"diagnostics\":[{{\"code\":{}}}],\"ok\":false,\"schema\":{}}}",
        quote(code),
        quote("re.native-fault-corpus-release-evidence@0.1.0"),
    );
}

fn print_host_executor_error(code: &str) {
    eprintln!(
        "{{\"diagnostics\":[{{\"code\":{}}}],\"ok\":false,\"schema\":{}}}",
        quote(code),
        quote("re.native-host-execution-result@0.1.0"),
    );
}

fn print_runtime_bundle_error(code: &str) {
    eprintln!(
        "{{\"diagnostics\":[{{\"code\":{}}}],\"ok\":false,\"schema\":{}}}",
        quote(code),
        quote(RUNTIME_BUNDLE_SCHEMA),
    );
}

fn print_project_error(code: &str) {
    println!(
        "{{\"diagnostics\":[{{\"code\":{}}}],\"ok\":false,\"schema\":{}}}",
        quote(code),
        quote("re.native-project-result@0.1.0"),
    );
}

fn print_project_runtime_error(code: &str) {
    println!(
        "{{\"diagnostics\":[{{\"code\":{}}}],\"ok\":false,\"schema\":{}}}",
        quote(code),
        quote("re.native-project-runtime-result@0.1.0"),
    );
}

fn eprint_project_runtime_error(code: &str) {
    eprintln!(
        "{{\"diagnostics\":[{{\"code\":{}}}],\"ok\":false,\"schema\":{}}}",
        quote(code),
        quote("re.native-project-runtime-result@0.1.0"),
    );
}

fn print_project_benchmark_error(code: &str) {
    println!(
        "{{\"diagnostics\":[{{\"code\":{}}}],\"ok\":false,\"schema\":{}}}",
        quote(code),
        quote(PROJECT_BENCHMARK_SCHEMA),
    );
}

fn print_node_free_error(code: &str) {
    println!(
        "{{\"diagnostics\":[{{\"code\":{}}}],\"ok\":false,\"schema\":{}}}",
        quote(code),
        quote("re.native-node-free-result@0.1.0"),
    );
}

fn print_release_error(code: &str) {
    println!(
        "{{\"diagnostics\":[{{\"code\":{}}}],\"ok\":false,\"schema\":{}}}",
        quote(code),
        quote("re.native-release-result@0.1.0"),
    );
}

fn print_compile_error(code: &str) {
    println!(
        "{{\"diagnostics\":[{{\"code\":{}}}],\"ok\":false,\"schema\":{}}}",
        quote(code),
        quote("re.native-compile-result@0.1.0"),
    );
}

fn read_source(path: &str) -> Result<(String, String), i32> {
    let bytes = fs::read(path).map_err(|_| 66)?;
    let source = SourceText::from_bytes(&bytes, path).map_err(|diagnostic| {
        println!(
            "{{\"diagnostics\":[{}],\"ok\":false,\"schema\":{}}}",
            diagnostic.to_json(),
            quote(CHECK_SCHEMA)
        );
        65
    })?;
    Ok((source.text, source.file))
}

fn token_json(token: &Token) -> String {
    let kind = match token.kind {
        TokenKind::Atom => "atom",
        TokenKind::End => "end",
        TokenKind::String => "string",
        TokenKind::Symbol => "symbol",
    };
    format!(
        "{{\"column\":{},\"end\":{},\"kind\":{},\"line\":{},\"start\":{},\"text\":{}}}",
        token.column,
        token.end,
        quote(kind),
        token.line,
        token.start,
        quote(&token.text),
    )
}

#[cfg(test)]
mod tests {
    use super::{
        PROJECT_CAPABILITY_ENTRY_RESULT, bind_loopback_listener, native_profile_digest,
        native_project_capability_contract_digest, native_toolchain_digest, next_workspace_id,
        server_smoke_failure_code, stable_diagnostic_code,
    };
    use revia_core::{bytecode::NATIVE_BYTECODE_PROFILE, digest::sha256_hex};

    #[test]
    fn project_capability_authority_digests_are_derived_from_native_contracts() {
        assert_eq!(
            native_profile_digest(),
            format!("sha256:{}", sha256_hex(NATIVE_BYTECODE_PROFILE.as_bytes()))
        );
        assert_eq!(
            native_toolchain_digest(),
            format!("sha256:{}", sha256_hex(b"re.native-rust-toolchain@0.1.0"))
        );
        assert_eq!(
            native_project_capability_contract_digest("revia.capability.args_success"),
            format!(
                "sha256:{}",
                sha256_hex(
                    format!("revia.capability.args_success.main:{PROJECT_CAPABILITY_ENTRY_RESULT}")
                        .as_bytes()
                )
            )
        );
        assert_ne!(
            native_profile_digest(),
            "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
        );
        assert_ne!(
            native_toolchain_digest(),
            "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
        );
        assert_ne!(
            native_project_capability_contract_digest("revia.capability.args_success"),
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        );
    }

    #[test]
    fn node_free_failure_detail_keeps_only_stable_diagnostic_codes() {
        assert_eq!(
            stable_diagnostic_code(
                br#"{"diagnostics":[{"code":"project-module-source-digest-mismatch","path":"/private"}]}"#,
            )
            .as_deref(),
            Some("project-module-source-digest-mismatch")
        );
        assert_eq!(
            stable_diagnostic_code(
                br#"{"diagnostics":[{"code":"ProjectFailure","detail":"unsafe"}]}"#,
            ),
            None
        );
    }

    #[test]
    fn server_smoke_failure_code_is_stable_and_path_free() {
        assert_eq!(
            server_smoke_failure_code("response-read"),
            "native-server-smoke-response-read-failure"
        );
        assert!(
            server_smoke_failure_code("response-read")
                .bytes()
                .all(|byte| {
                    byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"-_".contains(&byte)
                })
        );
    }

    #[test]
    fn server_smoke_listener_stays_on_loopback() {
        let (_, address) = bind_loopback_listener().unwrap();
        assert!(address.ip().is_loopback());
    }

    #[test]
    fn native_workspace_ids_are_process_local_and_monotonic() {
        let first = next_workspace_id();
        let second = next_workspace_id();
        assert_eq!(second, first + 1);
    }
}
