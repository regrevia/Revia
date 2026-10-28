#![forbid(unsafe_code)]
#![allow(
    clippy::result_large_err,
    reason = "WP-252 keeps diagnostics as complete stable value objects; boxing is deferred until native API and performance boundaries are measured"
)]

pub mod approval;
pub mod bytecode;
pub mod canonical_json;
pub mod capability_comparison;
pub mod capability_project_comparison;
pub mod comparison_catalog;
pub mod cross_language;
pub mod diagnostic;
pub mod digest;
pub mod experiment_kit;
pub mod fault_corpus;
pub mod graph;
pub mod lexer;
pub mod minimal_std;
pub mod multi_module;
pub mod node_free;
pub mod parser;
pub mod project;
pub mod project_runtime;
pub mod release;
pub mod release_evidence;
pub mod replay;
pub mod replay_catalog;
pub mod replay_fault_catalog;
pub mod runtime_bundle;
pub mod runtime_bundle_comparison;
pub mod server;
pub mod server_gate;
pub mod source;
pub mod task_runtime;
pub mod vm;
