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
const LAYOUT_LIST: &str = "layout/structs.list";

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

fn header_names(include_directory: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(include_directory)
        .unwrap_or_else(|error| {
            panic!(
                "delali-narsil cannot list {}: {error}",
                include_directory.display()
            )
        })
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.extension().is_some_and(|extension| extension == "h"))
        .filter_map(|path| {
            path.file_name()
                .map(|name| name.to_string_lossy().into_owned())
        })
        .collect();
    names.sort();
    names
}

struct StructLayout {
    name: String,
    fields: Vec<String>,
}

fn read_layout_list(path: &Path) -> Vec<StructLayout> {
    let text = fs::read_to_string(path)
        .unwrap_or_else(|error| panic!("delali-narsil cannot read {}: {error}", path.display()));
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let mut words = line.split_whitespace().map(str::to_string);
            let name = words.next().unwrap_or_default();
            StructLayout {
                name,
                fields: words.collect(),
            }
        })
        .collect()
}

fn write_layout_sources(
    structs: &[StructLayout],
    headers: &[String],
    out_directory: &Path,
) -> PathBuf {
    let mut c = String::from("#include <stddef.h>\n");
    for header in headers {
        c.push_str(&format!("#include \"{header}\"\n"));
    }
    c.push_str("const size_t narsil_rust_layout_values[] = {\n");
    let mut rust = String::from("pub(crate) const LAYOUT_NAMES: &[&str] = &[\n");
    let mut values =
        String::from("pub(crate) fn rust_layout_values() -> [usize; LAYOUT_COUNT] {\n    [\n");
    let mut count = 0usize;
    for layout in structs {
        let name = &layout.name;
        c.push_str(&format!("  sizeof({name}),\n  _Alignof({name}),\n"));
        rust.push_str(&format!(
            "    \"sizeof {name}\",\n    \"alignof {name}\",\n"
        ));
        values.push_str(&format!(
            "        ::core::mem::size_of::<super::{name}>(),\n        ::core::mem::align_of::<super::{name}>(),\n"
        ));
        count += 2;
        for field in &layout.fields {
            c.push_str(&format!("  offsetof({name}, {field}),\n"));
            rust.push_str(&format!("    \"offsetof {name}.{field}\",\n"));
            values.push_str(&format!(
                "        ::core::mem::offset_of!(super::{name}, {field}),\n"
            ));
            count += 1;
        }
    }
    c.push_str("};\n");
    rust.push_str("];\n");
    values.push_str("    ]\n}\n");
    rust.push_str(&format!(
        "pub(crate) const LAYOUT_COUNT: usize = {count};\n"
    ));
    rust.push_str(&values);
    let c_path = out_directory.join("narsil_layout.c");
    fs::write(&c_path, c)
        .unwrap_or_else(|error| panic!("delali-narsil cannot write {}: {error}", c_path.display()));
    let rust_path = out_directory.join("narsil_layout.rs");
    fs::write(&rust_path, rust).unwrap_or_else(|error| {
        panic!(
            "delali-narsil cannot write {}: {error}",
            rust_path.display()
        )
    });
    c_path
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
    let out_directory = PathBuf::from(env::var("OUT_DIR").expect("Cargo sets OUT_DIR"));
    let layout_list = manifest_directory.join(LAYOUT_LIST);
    sources.push(write_layout_sources(
        &read_layout_list(&layout_list),
        &header_names(&include_directory),
        &out_directory,
    ));

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
    println!("cargo:rerun-if-changed={}", layout_list.display());
    println!("cargo:rerun-if-changed={}", source_directory.display());
    println!("cargo:rerun-if-changed={}", include_directory.display());
    println!("cargo:rerun-if-env-changed=CC");
}
