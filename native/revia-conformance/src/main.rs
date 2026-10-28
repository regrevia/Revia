use std::{env, fs, path::Path, process};

use revia_core::{
    canonical_json::quote,
    digest::sha256_hex,
    parser::parse_source,
    project::{
        NativeDependency, NativeExport, NativeInterface, NativeModule, NativePackage,
        NativeProjectModule, serialize_project_manifest,
    },
    source::SourceText,
};

const SCHEMA: &str = "re.native-conformance-report@0.1.0";

fn main() {
    let files = env::args().skip(1).collect::<Vec<_>>();
    if files.is_empty() {
        eprintln!("Usage: revia-conformance <file> [...] | node-free-fixture <directory>");
        process::exit(64);
    }

    if let [command, path] = files.as_slice()
        && command == "node-free-fixture"
    {
        if let Err(code) = node_free_fixture(path) {
            process::exit(code);
        }
        return;
    }

    let mut accepted_count = 0usize;
    let mut rejected_count = 0usize;
    let mut results = Vec::with_capacity(files.len());
    for file in &files {
        let bytes = match fs::read(file) {
            Ok(bytes) => bytes,
            Err(error) => {
                eprintln!("{file}: {error}");
                process::exit(66);
            }
        };
        let source = match SourceText::from_bytes(&bytes, file) {
            Ok(source) => source,
            Err(error) => {
                rejected_count += 1;
                results.push(format!(
                    "{{\"accepted\":false,\"code\":{},\"file\":{}}}",
                    quote(&error.code),
                    quote(file),
                ));
                continue;
            }
        };
        match parse_source(&source.text, file) {
            Ok(_) => {
                accepted_count += 1;
                results.push(format!("{{\"accepted\":true,\"file\":{}}}", quote(file)));
            }
            Err(error) => {
                rejected_count += 1;
                results.push(format!(
                    "{{\"accepted\":false,\"code\":{},\"file\":{}}}",
                    quote(&error.code),
                    quote(file),
                ));
            }
        }
    }
    println!(
        "{{\"accepted_count\":{},\"fixture_count\":{},\"rejected_count\":{},\"results\":[{}],\"schema\":{}}}",
        accepted_count,
        files.len(),
        rejected_count,
        results.join(","),
        quote(SCHEMA),
    );
}

fn node_free_fixture(path: &str) -> Result<(), i32> {
    let root = Path::new(path);
    if root.exists() {
        let metadata = fs::symlink_metadata(root).map_err(|_| 66)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(65);
        }
        let mut entries = fs::read_dir(root).map_err(|_| 66)?;
        if entries.next().is_some() {
            return Err(65);
        }
    } else {
        fs::create_dir_all(root).map_err(|_| 73)?;
    }
    fs::create_dir_all(root.join("modules")).map_err(|_| 73)?;

    let mut project_modules = Vec::with_capacity(50);
    let mut package_modules = Vec::with_capacity(50);
    let mut interface_digests: Vec<String> = Vec::with_capacity(50);
    for index in 0..50 {
        let name = format!("agent.enterprise.m{index:03}");
        let source = if index == 0 {
            include_str!("../../../examples/hello.re").to_owned()
        } else {
            format!(
                "re 1.0 compact\nmodule {name}\nexport route_{index:03}\nexport task_{index:03}\n"
            )
        };
        let source_digest = format!("sha256:{}", sha256_hex(source.as_bytes()));
        let path = format!("modules/m{index:03}.re");
        fs::write(root.join(&path), source.as_bytes()).map_err(|_| 73)?;

        let mut dependencies = Vec::new();
        if index > 0 {
            dependencies.push(NativeDependency::package(
                "previous",
                interface_digests[index - 1].clone(),
                format!("agent.enterprise.m{:03}", index - 1),
            ));
        }
        if index == 49 {
            dependencies.push(NativeDependency::package(
                "root",
                interface_digests[1].clone(),
                "agent.enterprise.m001",
            ));
        }
        let exports = if index == 0 {
            vec![
                NativeExport::function(
                    "main",
                    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                ),
                NativeExport::function(
                    "task_000",
                    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                ),
            ]
        } else {
            vec![
                NativeExport::function(
                    format!("route_{index:03}"),
                    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                ),
                NativeExport::function(
                    format!("task_{index:03}"),
                    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                ),
            ]
        };
        let interface = NativeInterface::new(name.clone(), dependencies, exports);
        let interface_digest = interface.digest().map_err(|_| 65)?;
        interface_digests.push(interface_digest.clone());
        project_modules.push(NativeProjectModule::new(
            name.clone(),
            path,
            source_digest.clone(),
        ));
        package_modules.push(NativeModule::new(name, source_digest, interface));
    }
    let package = NativePackage::new("agent.enterprise", package_modules);
    let manifest = serialize_project_manifest(&project_modules, &package).map_err(|_| 65)?;
    fs::write(root.join("project.json"), manifest).map_err(|_| 73)?;
    println!(
        "{{\"module_count\":50,\"public_symbol_count\":100,\"schema\":{}}}",
        quote("re.native-node-free-fixture@0.1.0")
    );
    Ok(())
}
