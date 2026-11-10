use std::sync::OnceLock;

include!(concat!(env!("OUT_DIR"), "/narsil_layout.rs"));

unsafe extern "C" {
    static narsil_rust_layout_values: [usize; LAYOUT_COUNT];
}

fn core_layout_values() -> [usize; LAYOUT_COUNT] {
    unsafe { narsil_rust_layout_values }
}

fn layout_mismatches() -> Vec<String> {
    let core = core_layout_values();
    let rust = rust_layout_values();
    LAYOUT_NAMES
        .iter()
        .zip(core.iter().zip(rust.iter()))
        .filter(|(_, (core_value, rust_value))| core_value != rust_value)
        .map(|(name, (core_value, rust_value))| {
            format!("{name}: the core has {core_value}, the Rust bindings have {rust_value}")
        })
        .collect()
}

pub(crate) fn core_layout_matches() -> Result<(), &'static str> {
    static CHECKED: OnceLock<Result<(), String>> = OnceLock::new();
    let outcome = CHECKED.get_or_init(|| {
        let mismatches = layout_mismatches();
        if mismatches.is_empty() {
            Ok(())
        } else {
            Err(mismatches.join("; "))
        }
    });
    outcome.as_ref().map(|_| ()).map_err(String::as_str)
}
