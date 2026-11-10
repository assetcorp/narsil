mod support;

use std::fs;
use std::process::Command;

use narsil::conformance::{read_sample, write_sample};
use narsil::{Value, parse_json, write_json};
use support::{ScratchDirectory, conformance_root};

struct Sample {
    name: String,
    kind: String,
    file: String,
    expected: String,
    storage: Option<String>,
}

fn samples() -> Vec<Sample> {
    let root = conformance_root();
    let text =
        fs::read_to_string(root.join("samples/samples.json")).expect("samples.json is readable");
    let catalog = parse_json(&text).expect("samples.json is JSON");
    let entries = catalog
        .pointer("samples")
        .and_then(Value::as_array)
        .expect("samples.json lists samples");
    entries
        .iter()
        .map(|entry| {
            let field = |key: &str| {
                entry
                    .pointer(key)
                    .and_then(Value::as_str)
                    .map(str::to_string)
            };
            Sample {
                name: field("name").expect("a sample has a name"),
                kind: field("kind").expect("a sample has a kind"),
                file: field("file").expect("a sample has a file"),
                expected: field("expected").expect("a sample has an expected form"),
                storage: field("storage"),
            }
        })
        .collect()
}

fn run_check(command: &str, directory: &std::path::Path) -> (bool, String) {
    let cli = conformance_root().join("dist/cli.mjs");
    let output = Command::new("node")
        .arg(cli)
        .arg(command)
        .arg(directory)
        .output()
        .expect("node runs the suite");
    let report = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    (output.status.success(), report)
}

#[test]
fn every_sample_reads_and_writes_as_the_reference_does() {
    let root = conformance_root();
    let scratch = ScratchDirectory::new("conformance-files");
    let read_directory = scratch.path().join("read");
    let written_directory = scratch.path().join("written");
    let mut problems = Vec::new();
    for sample in samples() {
        let bytes =
            fs::read(root.join("samples").join(&sample.file)).expect("the sample file is readable");
        let storage = sample.storage.as_deref();
        match read_sample(&sample.kind, &bytes, storage) {
            Ok(form) => {
                let path = read_directory.join(format!("{}.json", sample.name));
                fs::create_dir_all(path.parent().expect("a sample path has a parent"))
                    .expect("the directory is made");
                fs::write(path, write_json(&form)).expect("the read form is written");
            }
            Err(error) => problems.push(format!("read {}: {error}", sample.name)),
        }
        let expected_text = fs::read_to_string(root.join("samples").join(&sample.expected))
            .expect("the expected form is readable");
        let expected = parse_json(&expected_text).expect("the expected form is JSON");
        match write_sample(&sample.kind, &expected, storage) {
            Ok(file) => {
                let path = written_directory.join(&sample.name);
                fs::create_dir_all(path.parent().expect("a sample path has a parent"))
                    .expect("the directory is made");
                fs::write(path, file).expect("the written sample is saved");
            }
            Err(error) => problems.push(format!("write {}: {error}", sample.name)),
        }
    }
    let (read_passes, read_report) = run_check("check-read", &read_directory);
    let (written_passes, written_report) = run_check("check-written", &written_directory);
    assert!(
        problems.is_empty() && read_passes && written_passes,
        "{}\n--- check-read ---\n{read_report}\n--- check-written ---\n{written_report}",
        problems.join("\n")
    );
}
