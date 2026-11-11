mod support;

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;

use flate2::read::GzDecoder;
use narsil::{Map, Narsil, Value, parse_json, write_json};
use support::portable::{
    Tier, documents, export_of, fill, held_documents, index_config, snapshot_of, with_id,
};
use support::{ScratchDirectory, conformance_root, repository_root};

const TIERS: [Tier; 3] = [Tier::Memory, Tier::Log, Tier::Snapshot];
const PRODUCTS_ARCHIVE: &str = "files/snapshot-archive/products.tar";
const PRODUCTS_EXPORT: &str = "files/document-export/products.jsonl";
const PRODUCTS_EXPECTED: &str = "damaged/expected/products.json";
const EARLIER_SNAPSHOT: &str = "earlier-releases/0.3.0/products-0.3.0.nrsl";
const EARLIER_SNAPSHOT_EXPECTED: &str =
    "earlier-releases/0.3.0/expected/index-snapshot-products.json";
const RESTORE_STAGING_PREFIX: &str = ".restore-";

fn samples() -> PathBuf {
    conformance_root().join("samples")
}

fn sample_bytes(relative: &str) -> Vec<u8> {
    std::fs::read(samples().join(relative)).unwrap_or_else(|error| panic!("{relative}: {error}"))
}

fn documents_of(value: &Value, label: &str) -> BTreeMap<String, Map> {
    let Value::Object(documents) = value else {
        panic!("{label} holds no object of documents");
    };
    documents
        .iter()
        .map(|(id, document)| match document {
            Value::Object(document) => (id.clone(), document.clone()),
            _ => panic!("{label} holds a document that is not an object"),
        })
        .collect()
}

fn expected_documents(relative: &str) -> BTreeMap<String, Map> {
    let text = std::fs::read_to_string(samples().join(relative))
        .unwrap_or_else(|error| panic!("{relative}: {error}"));
    documents_of(
        &parse_json(&text).expect("the expected documents parse"),
        relative,
    )
}

fn ids_of(documents: &BTreeMap<String, Map>) -> Vec<String> {
    documents.keys().cloned().collect()
}

fn index_names(narsil: &Narsil) -> Vec<String> {
    narsil
        .list_indexes()
        .into_iter()
        .map(|info| info.name)
        .collect()
}

fn staged_files_left_in(directory: &Path, inside_staging: bool) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let staging = inside_staging
            || entry
                .file_name()
                .to_string_lossy()
                .starts_with(RESTORE_STAGING_PREFIX);
        if path.is_dir() {
            found.extend(staged_files_left_in(&path, staging));
        } else if staging {
            found.push(path);
        }
    }
    found
}

fn checkpoint_every_index(narsil: &Narsil, tier: Tier) {
    if !matches!(tier, Tier::Snapshot) {
        return;
    }
    for name in index_names(narsil) {
        narsil.checkpoint(&name).expect("the checkpoint writes");
    }
}

fn reopen(narsil: Narsil, tier: Tier, root: &Path) -> Narsil {
    checkpoint_every_index(&narsil, tier);
    narsil.shutdown().expect("the engine shuts down");
    drop(narsil);
    tier.open(root)
}

struct DamagedCase {
    name: String,
    file: String,
    gzip: bool,
    code: Option<String>,
    line: Option<usize>,
    imported: Option<u64>,
    documents: Option<String>,
}

fn damaged_cases(open: &str) -> Vec<DamagedCase> {
    let text =
        std::fs::read_to_string(samples().join("damaged/cases.json")).expect("cases.json reads");
    let parsed = parse_json(&text).expect("cases.json parses");
    let Some(Value::Array(cases)) = parsed.as_object().and_then(|root| root.get("cases")) else {
        panic!("cases.json lists no cases");
    };
    let text_of = |case: &Map, key: &str| case.get(key).and_then(Value::as_str).map(str::to_string);
    cases
        .iter()
        .filter_map(Value::as_object)
        .filter(|case| text_of(case, "open").as_deref() == Some(open))
        .map(|case| {
            let expect = case
                .get("expect")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            DamagedCase {
                name: text_of(case, "name").unwrap_or_default(),
                file: text_of(case, "file").unwrap_or_default(),
                gzip: matches!(case.get("gzip"), Some(Value::Bool(true))),
                code: text_of(&expect, "code"),
                line: expect
                    .get("line")
                    .and_then(Value::as_f64)
                    .map(|line| line as usize),
                imported: expect
                    .get("imported")
                    .and_then(Value::as_f64)
                    .map(|count| count as u64),
                documents: text_of(&expect, "documents"),
            }
        })
        .collect()
}

fn case_bytes(case: &DamagedCase) -> Vec<u8> {
    let bytes = sample_bytes(&case.file);
    if !case.gzip {
        return bytes;
    }
    let mut text = Vec::new();
    GzDecoder::new(bytes.as_slice())
        .read_to_end(&mut text)
        .expect("the case's gzip stream inflates");
    text
}

fn refusal_problem(outcome: narsil::Result<()>, code: &str) -> Option<String> {
    match outcome {
        Ok(()) => Some(format!("restored where the reference refuses with {code}")),
        Err(error) if error.code().as_str() == code => None,
        Err(error) => Some(format!(
            "refused with {} where the reference refuses with {code}: {}",
            error.code().as_str(),
            error.message()
        )),
    }
}

#[test]
fn every_damaged_archive_gets_the_reference_code_through_a_full_restore_and_changes_nothing() {
    let cases = damaged_cases("archive");
    assert_eq!(
        cases.len(),
        14,
        "cases.json lists {} archive cases",
        cases.len()
    );
    let products = expected_documents(PRODUCTS_EXPECTED);
    let ids = ids_of(&products);
    let good = sample_bytes(PRODUCTS_ARCHIVE);
    let mut problems = Vec::new();
    for tier in TIERS {
        let root = ScratchDirectory::new("damaged-archive");
        let mut narsil = tier.open(root.path());
        for case in &cases {
            let code = case.code.as_deref().unwrap_or_default();
            let bytes = sample_bytes(&case.file);
            let outcome = narsil.restore("fresh", &mut bytes.as_slice());
            if let Some(problem) = refusal_problem(outcome, code) {
                problems.push(format!(
                    "{tier:?} {} into a new index: {problem}",
                    case.name
                ));
            }
            if index_names(&narsil).iter().any(|name| name == "fresh") {
                problems.push(format!(
                    "{tier:?} {}: the refused restore left an index",
                    case.name
                ));
            }
        }
        narsil
            .restore("products", &mut good.as_slice())
            .expect("the reference archive restores");
        assert_eq!(
            held_documents(&narsil, "products", &ids),
            products,
            "{tier:?}"
        );
        for case in &cases {
            let code = case.code.as_deref().unwrap_or_default();
            let bytes = sample_bytes(&case.file);
            let outcome = narsil.restore("products", &mut bytes.as_slice());
            if let Some(problem) = refusal_problem(outcome, code) {
                problems.push(format!("{tier:?} {} over an index: {problem}", case.name));
            }
            if held_documents(&narsil, "products", &ids) != products {
                problems.push(format!(
                    "{tier:?} {}: the refused restore changed the index",
                    case.name
                ));
            }
        }
        if tier.durable() {
            narsil = reopen(narsil, tier, root.path());
            assert_eq!(
                index_names(&narsil),
                vec!["products".to_string()],
                "{tier:?}"
            );
            assert_eq!(
                held_documents(&narsil, "products", &ids),
                products,
                "{tier:?}"
            );
            narsil.shutdown().expect("the engine shuts down");
        }
        let left = staged_files_left_in(root.path(), false);
        assert!(left.is_empty(), "{tier:?} left staging behind: {left:?}");
    }
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

fn import_problem(
    narsil: &Narsil,
    index: &str,
    case: &DamagedCase,
    products: &BTreeMap<String, Map>,
) -> Result<Option<BTreeMap<String, Map>>, String> {
    let bytes = case_bytes(case);
    let outcome = narsil.import_documents(index, &mut bytes.as_slice());
    let ids = ids_of(products);
    match (outcome, &case.code, case.line, &case.documents) {
        (Err(error), Some(code), None, _) if error.code().as_str() == code => {
            if index_names(narsil).iter().any(|name| name == index) {
                return Err("the refused import left an index".to_string());
            }
            Ok(None)
        }
        (Ok(result), Some(code), Some(line), _) => {
            let refused: Vec<(usize, &str)> = result
                .refused
                .iter()
                .map(|refusal| (refusal.line, refusal.code.as_str()))
                .collect();
            if refused != vec![(line, code.as_str())] || result.refused_count != 1 {
                return Err(format!(
                    "refused {refused:?} where the reference refuses line {line} with {code}"
                ));
            }
            if Some(result.imported) != case.imported {
                return Err(format!("imported {} documents", result.imported));
            }
            let held = held_documents(narsil, index, &ids);
            let whole = held
                .iter()
                .all(|(id, document)| products.get(id) == Some(document));
            if held.len() as u64 != result.imported || !whole {
                return Err(format!(
                    "holds {} documents, not each one the reference holds",
                    held.len()
                ));
            }
            Ok(Some(held))
        }
        (Ok(result), None, None, Some(documents)) => {
            let expected = expected_documents(documents);
            let held = held_documents(narsil, index, &ids_of(&expected));
            if held != expected
                || result.imported != expected.len() as u64
                || result.refused_count != 0
            {
                return Err(format!(
                    "imported {} and refused {} where the reference imports {}",
                    result.imported,
                    result.refused_count,
                    expected.len()
                ));
            }
            Ok(Some(held))
        }
        (Ok(result), _, _, _) => Err(format!(
            "imported {} and refused {:?}",
            result.imported,
            result
                .refused
                .iter()
                .map(|refusal| (refusal.line, refusal.code.as_str()))
                .collect::<Vec<_>>()
        )),
        (Err(error), _, _, _) => Err(format!(
            "refused with {}: {}",
            error.code().as_str(),
            error.message()
        )),
    }
}

#[test]
fn every_damaged_export_gets_the_reference_outcome_through_a_full_import() {
    let cases = damaged_cases("export");
    assert_eq!(
        cases.len(),
        16,
        "cases.json lists {} export cases",
        cases.len()
    );
    let products = expected_documents(PRODUCTS_EXPECTED);
    let mut problems = Vec::new();
    for tier in TIERS {
        let root = ScratchDirectory::new("damaged-export");
        let mut narsil = tier.open(root.path());
        let mut kept = Vec::new();
        for (position, case) in cases.iter().enumerate() {
            let index = format!("imported-{position}");
            match import_problem(&narsil, &index, case, &products) {
                Ok(Some(held)) => kept.push((index, held)),
                Ok(None) => {}
                Err(problem) => problems.push(format!("{tier:?} {}: {problem}", case.name)),
            }
        }
        if !tier.durable() {
            continue;
        }
        narsil = reopen(narsil, tier, root.path());
        for (index, held) in &kept {
            let ids = ids_of(held);
            assert_eq!(
                &held_documents(&narsil, index, &ids),
                held,
                "{tier:?} {index}"
            );
            let count = narsil.count_documents(index).expect("the count reads");
            assert_eq!(count, held.len() as u64, "{tier:?} {index}");
        }
        narsil.shutdown().expect("the engine shuts down");
    }
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

fn reference_samples() -> [(&'static str, &'static str, BTreeMap<String, Map>); 3] {
    [
        (
            "archive",
            PRODUCTS_ARCHIVE,
            expected_documents(PRODUCTS_EXPECTED),
        ),
        (
            "export",
            PRODUCTS_EXPORT,
            expected_documents(PRODUCTS_EXPECTED),
        ),
        (
            "earlier",
            EARLIER_SNAPSHOT,
            expected_documents(EARLIER_SNAPSHOT_EXPECTED),
        ),
    ]
}

#[test]
fn files_that_the_reference_wrote_restore_and_import_whole_on_every_tier() {
    for tier in TIERS {
        let root = ScratchDirectory::new("reference-files");
        let mut narsil = tier.open(root.path());
        for (index, relative, expected) in &reference_samples() {
            let bytes = sample_bytes(relative);
            if *index == "export" {
                let result = narsil
                    .import_documents(index, &mut bytes.as_slice())
                    .unwrap_or_else(|error| panic!("{tier:?} {relative}: {error}"));
                assert_eq!(
                    result.refused_count, 0,
                    "{tier:?} {relative}: {:?}",
                    result.refused
                );
                assert_eq!(
                    result.imported,
                    expected.len() as u64,
                    "{tier:?} {relative}"
                );
            } else {
                narsil
                    .restore(index, &mut bytes.as_slice())
                    .unwrap_or_else(|error| panic!("{tier:?} {relative}: {error}"));
            }
            let held = held_documents(&narsil, index, &ids_of(expected));
            assert!(&held == expected, "{tier:?} {relative}: other documents");
        }
        if !tier.durable() {
            continue;
        }
        narsil = reopen(narsil, tier, root.path());
        for (index, relative, expected) in &reference_samples() {
            let held = held_documents(&narsil, index, &ids_of(expected));
            assert!(
                &held == expected,
                "{tier:?} {relative} after a reopen: other documents"
            );
            let count = narsil.count_documents(index).expect("the count reads");
            assert_eq!(
                count,
                expected.len() as u64,
                "{tier:?} {relative} after a reopen"
            );
        }
        narsil.shutdown().expect("the engine shuts down");
    }
}

fn path_text(path: &Path) -> Value {
    Value::String(path.to_string_lossy().into_owned())
}

fn reference(spec: Map, scratch: &Path) -> Map {
    let spec_path = scratch.join("spec.json");
    std::fs::write(&spec_path, write_json(&Value::Object(spec))).expect("the spec is written");
    let script =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/support/reference_portability.mjs");
    let output = Command::new("node")
        .arg(script)
        .arg(repository_root())
        .arg(&spec_path)
        .output()
        .expect("node runs the TypeScript reference");
    assert!(
        output.status.success(),
        "the TypeScript reference failed; build packages/ts first: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = String::from_utf8(output.stdout).expect("the reference writes UTF-8");
    match parse_json(&text).expect("the reference writes JSON") {
        Value::Object(outcome) => outcome,
        _ => panic!("the reference wrote no object"),
    }
}

fn reference_reads(
    archive: &[u8],
    export: &[u8],
    ids: &[String],
) -> (BTreeMap<String, Map>, f64, BTreeMap<String, Map>) {
    let scratch = ScratchDirectory::new("reference-read");
    let archive_path = scratch.path().join("archive.tar");
    let export_path = scratch.path().join("export.jsonl");
    std::fs::write(&archive_path, archive).expect("the archive is written");
    std::fs::write(&export_path, export).expect("the export is written");
    let mut spec = Map::new();
    spec.insert("mode", Value::String("read".into()));
    spec.insert("archive", path_text(&archive_path));
    spec.insert("export", path_text(&export_path));
    spec.insert(
        "ids",
        Value::Array(ids.iter().cloned().map(Value::String).collect()),
    );
    let outcome = reference(spec, scratch.path());
    let part = |name: &str| -> Map {
        let Some(Value::Object(part)) = outcome.get(name) else {
            panic!("the reference gave no {name} outcome");
        };
        assert!(
            part.get("error").is_none(),
            "the reference refused the {name}: {:?}",
            part.get("error")
        );
        part.clone()
    };
    let restored = part("archive");
    let imported = part("export");
    let count = imported
        .get("imported")
        .and_then(Value::as_f64)
        .unwrap_or(-1.0);
    (
        documents_of(
            restored.get("documents").unwrap_or(&Value::Null),
            "the restored index",
        ),
        count,
        documents_of(
            imported.get("documents").unwrap_or(&Value::Null),
            "the imported index",
        ),
    )
}

fn reference_writes(documents: &BTreeMap<String, Map>) -> (Vec<u8>, Vec<u8>) {
    let scratch = ScratchDirectory::new("reference-write");
    let archive_path = scratch.path().join("archive.tar");
    let export_path = scratch.path().join("export.jsonl");
    let mut config = Map::new();
    config.insert("schema", index_config().schema);
    let batch = documents
        .iter()
        .map(|(id, document)| Value::Object(with_id(id, document)))
        .collect();
    let mut spec = Map::new();
    spec.insert("mode", Value::String("write".into()));
    spec.insert("config", Value::Object(config));
    spec.insert("documents", Value::Array(batch));
    spec.insert("archive", path_text(&archive_path));
    spec.insert("export", path_text(&export_path));
    reference(spec, scratch.path());
    (
        std::fs::read(&archive_path).expect("the reference wrote an archive"),
        std::fs::read(&export_path).expect("the reference wrote an export"),
    )
}

fn require_reference_reads(
    narsil: &Narsil,
    index: &str,
    expected: &BTreeMap<String, Map>,
    label: &str,
) {
    let ids = ids_of(expected);
    let (restored, imported, from_export) =
        reference_reads(&snapshot_of(narsil, index), &export_of(narsil, index), &ids);
    assert!(
        &restored == expected,
        "{label}: the reference restored other documents"
    );
    assert_eq!(imported, expected.len() as f64, "{label}");
    assert!(
        &from_export == expected,
        "{label}: the reference imported other documents"
    );
}

#[test]
fn snapshots_and_exports_cross_between_the_reference_and_this_crate_both_ways() {
    let original = documents("doc", 0..300);
    let ids = ids_of(&original);
    let (reference_archive, reference_export) = reference_writes(&original);
    let products = expected_documents(PRODUCTS_EXPECTED);
    let products_archive = sample_bytes(PRODUCTS_ARCHIVE);
    for tier in TIERS {
        let root = ScratchDirectory::new("cross");
        let narsil = tier.open(root.path());
        narsil
            .restore("from-reference", &mut reference_archive.as_slice())
            .expect("the reference's archive restores");
        assert_eq!(
            held_documents(&narsil, "from-reference", &ids),
            original,
            "{tier:?}"
        );
        let result = narsil
            .import_documents("imported", &mut reference_export.as_slice())
            .expect("the reference's export imports");
        assert_eq!(
            (result.imported, result.refused_count),
            (300, 0),
            "{tier:?}"
        );
        assert_eq!(
            held_documents(&narsil, "imported", &ids),
            original,
            "{tier:?}"
        );
        narsil
            .create_index("written", index_config())
            .expect("the index is created");
        fill(&narsil, "written", &original);
        require_reference_reads(&narsil, "written", &original, &format!("{tier:?} written"));
        narsil
            .restore("products", &mut products_archive.as_slice())
            .expect("the products archive restores");
        require_reference_reads(
            &narsil,
            "products",
            &products,
            &format!("{tier:?} products"),
        );
        narsil.shutdown().expect("the engine shuts down");
    }
}
