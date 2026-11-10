use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const PACKAGED_CORE_DIRECTORY: &str = "core";
const WORKSPACE_CORE_DIRECTORY: &str = "../native";
const CORE_LIBRARY_NAME: &str = "narsil_core";
const MSVC_CLANG_COMPILER: &str = "clang-cl";
const ABI_VERSION_MACRO: &str = "NARSIL_CORE_ABI_VERSION";
const ABI_VERSION_VARIABLE: &str = "NARSIL_CORE_HEADER_ABI_VERSION";

fn core_directory(manifest_directory: &Path) -> PathBuf {
    let packaged = manifest_directory.join(PACKAGED_CORE_DIRECTORY);
    if packaged.join("include").join("narsil_core.h").is_file() {
        return packaged;
    }
    let workspace = manifest_directory.join(WORKSPACE_CORE_DIRECTORY);
    if workspace.join("include").join("narsil_core.h").is_file() {
        return workspace;
    }
    panic!(
        "delali-narsil finds the C sources of the Narsil core neither in {} nor in {}, so it cannot build the core",
        packaged.display(),
        workspace.display()
    );
}

fn collect_sources(directory: &Path, sources: &mut Vec<PathBuf>) {
    let mut entries: Vec<PathBuf> = fs::read_dir(directory)
        .unwrap_or_else(|error| {
            panic!("delali-narsil cannot list {}: {error}", directory.display())
        })
        .map(|entry| {
            entry
                .unwrap_or_else(|error| {
                    panic!(
                        "delali-narsil cannot read an entry of {}: {error}",
                        directory.display()
                    )
                })
                .path()
        })
        .collect();
    entries.sort();
    for path in entries {
        if path.is_dir() {
            collect_sources(&path, sources);
        } else if path.extension().is_some_and(|extension| extension == "c") {
            sources.push(path);
        }
    }
}

fn header_abi_version(include_directory: &Path) -> String {
    let header = include_directory.join("narsil_core.h");
    let text = fs::read_to_string(&header)
        .unwrap_or_else(|error| panic!("delali-narsil cannot read {}: {error}", header.display()));
    text.lines()
        .find_map(|line| {
            let mut words = line.split_whitespace();
            match (words.next(), words.next(), words.next()) {
                (Some("#define"), Some(ABI_VERSION_MACRO), Some(value))
                    if value.bytes().all(|byte| byte.is_ascii_digit()) =>
                {
                    Some(value.to_string())
                }
                _ => None,
            }
        })
        .unwrap_or_else(|| {
            panic!(
                "delali-narsil finds no {ABI_VERSION_MACRO} in {}",
                header.display()
            )
        })
}

fn environment_names_a_compiler(target: &str) -> bool {
    let underscored = target.replace('-', "_");
    [
        "CC".to_string(),
        format!("CC_{target}"),
        format!("CC_{underscored}"),
        "TARGET_CC".to_string(),
    ]
    .iter()
    .any(|name| env::var_os(name).is_some())
}

fn clang_cl_runs() -> bool {
    Command::new(MSVC_CLANG_COMPILER)
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn main() {
    let manifest_directory =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("Cargo sets CARGO_MANIFEST_DIR"));
    let target = env::var("TARGET").expect("Cargo sets TARGET");
    let target_env = env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    let core = core_directory(&manifest_directory);
    let source_directory = core.join("src");
    let include_directory = core.join("include");
    println!(
        "cargo:rustc-env={ABI_VERSION_VARIABLE}={}",
        header_abi_version(&include_directory)
    );

    let mut sources = Vec::new();
    collect_sources(&source_directory, &mut sources);

    let mut build = cc::Build::new();
    let msvc = target_env == "msvc";
    if msvc && !environment_names_a_compiler(&target) {
        if !clang_cl_runs() {
            panic!(
                "delali-narsil builds the Narsil core with clang-cl on an MSVC target, because the core uses C11 atomics and compiler builtins that cl.exe lacks. Install LLVM, or set CC to a clang that targets {target}."
            );
        }
        build.compiler(MSVC_CLANG_COMPILER);
    }
    build
        .files(&sources)
        .include(&include_directory)
        .std("c11")
        .opt_level(2)
        .warnings(false)
        .extra_warnings(false);
    if msvc {
        build.flag("/clang:-ffp-contract=off");
    } else {
        build
            .flag("-ffp-contract=off")
            .flag("-fvisibility=hidden")
            .define("_POSIX_C_SOURCE", "200809L");
    }
    build.compile(CORE_LIBRARY_NAME);

    if !msvc && env::var("CARGO_CFG_TARGET_OS").is_ok_and(|os| os != "windows") {
        println!("cargo:rustc-link-lib=m");
    }
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed={}", source_directory.display());
    println!("cargo:rerun-if-changed={}", include_directory.display());
    println!("cargo:rerun-if-env-changed=CC");
}
