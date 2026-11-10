mod support;

use std::collections::BTreeMap;
use std::path::Path;

use narsil::{
    DurabilityConfig, DurabilityTier, FilesystemPersistence, Map, Narsil, NarsilConfig,
    QueryParams, SearchMode, Value, VectorQuery, parse_json,
};
use support::{ScratchDirectory, conformance_root};

const EARLIER_GRAPH_KEY: &str = "segments/vec-embedding-1l4nfg2-graph-g1";

fn samples() -> std::path::PathBuf {
    conformance_root().join("samples")
}

fn copy_tree(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).expect("the copy's directory is made");
    for entry in std::fs::read_dir(from).expect("the sample directory reads") {
        let entry = entry.expect("the sample entry reads");
        let target = to.join(entry.file_name());
        if entry.file_type().expect("the entry has a type").is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), &target).expect("the sample file copies");
        }
    }
}

fn place(directory: &Path, relative: &str, source: &Path) {
    let target = directory.join(relative);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).expect("the overlay's directory is made");
    }
    std::fs::copy(source, &target).expect("the overlay file copies");
}

fn log_tier(root: &Path) -> NarsilConfig {
    NarsilConfig {
        durability: Some(DurabilityConfig {
            directory: Some(root.to_path_buf()),
            ..DurabilityConfig::default()
        }),
        ..NarsilConfig::default()
    }
}

fn snapshot_tier(root: &Path) -> NarsilConfig {
    let adapter = FilesystemPersistence::new(root).expect("the persistence directory opens");
    NarsilConfig {
        durability: Some(DurabilityConfig {
            tier: Some(DurabilityTier::Snapshot),
            ..DurabilityConfig::default()
        }),
        persistence: Some(std::sync::Arc::new(adapter)),
        ..NarsilConfig::default()
    }
}

fn expected_documents(relative: &str) -> BTreeMap<String, Map> {
    let text =
        std::fs::read_to_string(samples().join(relative)).expect("the expected documents read");
    let Value::Object(documents) = parse_json(&text).expect("the expected documents parse") else {
        panic!("{relative} holds no object");
    };
    documents
        .iter()
        .map(|(id, document)| match document {
            Value::Object(document) => (id.clone(), document.clone()),
            _ => panic!("{relative} holds a document that is not an object"),
        })
        .collect()
}

fn search_every_vector_field(narsil: &Narsil, index: &str) -> narsil::Result<()> {
    let sample = narsil.query(
        index,
        &QueryParams {
            limit: Some(1),
            ..QueryParams::default()
        },
    )?;
    let Some(hit) = sample.hits.first() else {
        return Ok(());
    };
    let Some(document) = narsil.get(index, &hit.id)? else {
        return Ok(());
    };
    for status in narsil.vector_maintenance_status(index)? {
        let Some(Value::Array(values)) = document.get(&status.field_name) else {
            continue;
        };
        let mut value = vec![0.0_f32; values.len()];
        if let Some(first) = value.first_mut() {
            *first = 1.0;
        }
        let query = QueryParams {
            mode: Some(SearchMode::Vector),
            limit: Some(10),
            vector: Some(VectorQuery {
                field: status.field_name.clone(),
                value: Some(value),
                text: None,
                similarity: None,
                metric: None,
                ef_search: None,
                oversample: None,
            }),
            ..QueryParams::default()
        };
        narsil.query(index, &query)?;
    }
    Ok(())
}

fn held_documents(
    narsil: &Narsil,
    index: &str,
    ids: &[String],
) -> narsil::Result<BTreeMap<String, Map>> {
    let held = narsil.get_multiple(index, ids)?;
    Ok(held
        .into_iter()
        .map(|(id, mut document)| {
            document.remove("id");
            (id, document)
        })
        .collect())
}

struct CheckpointCase {
    name: String,
    index: String,
    base: String,
    files: Vec<(String, String)>,
    remove: Option<String>,
    search: Option<String>,
    code: Option<String>,
    documents: Option<String>,
}

fn checkpoint_cases() -> Vec<CheckpointCase> {
    let text =
        std::fs::read_to_string(samples().join("damaged/cases.json")).expect("cases.json reads");
    let parsed = parse_json(&text).expect("cases.json parses");
    let Some(Value::Array(cases)) = parsed
        .as_object()
        .and_then(|root| root.get("cases"))
        .cloned()
    else {
        panic!("cases.json lists no cases");
    };
    let text_of = |case: &Map, key: &str| case.get(key).and_then(Value::as_str).map(str::to_string);
    cases
        .iter()
        .filter_map(Value::as_object)
        .filter(|case| text_of(case, "open").as_deref() == Some("checkpoint"))
        .map(|case| {
            let expect = case
                .get("expect")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let files = case
                .get("files")
                .and_then(Value::as_object)
                .map(|files| {
                    files
                        .iter()
                        .filter_map(|(relative, source)| {
                            source
                                .as_str()
                                .map(|source| (relative.clone(), source.to_string()))
                        })
                        .collect()
                })
                .unwrap_or_default();
            CheckpointCase {
                name: text_of(case, "name").unwrap_or_default(),
                index: text_of(case, "index").unwrap_or_default(),
                base: text_of(case, "base").unwrap_or_default(),
                files,
                remove: text_of(case, "remove"),
                search: text_of(case, "search"),
                code: text_of(&expect, "code"),
                documents: text_of(&expect, "documents"),
            }
        })
        .collect()
}

enum Outcome {
    Refused(String),
    Opened(BTreeMap<String, Map>, u64),
}

fn open_case(case: &CheckpointCase, wanted_ids: &[String]) -> Outcome {
    let root = ScratchDirectory::new("damaged");
    let directory = root.path().join(&case.index);
    copy_tree(&samples().join(&case.base), &directory);
    for (relative, source) in &case.files {
        place(&directory, relative, &samples().join(source));
    }
    let opened = (|| -> narsil::Result<(BTreeMap<String, Map>, u64)> {
        let narsil = Narsil::open(log_tier(root.path()))?;
        let outcome = (|| -> narsil::Result<(BTreeMap<String, Map>, u64)> {
            if let Some(id) = &case.remove {
                narsil.remove(&case.index, id)?;
            }
            if let Some(term) = &case.search {
                let query = QueryParams {
                    term: Some(term.clone()),
                    limit: Some(10),
                    ..QueryParams::default()
                };
                narsil.query(&case.index, &query)?;
            }
            search_every_vector_field(&narsil, &case.index)?;
            narsil.export_documents(&case.index, &mut std::io::sink())?;
            let held = held_documents(&narsil, &case.index, wanted_ids)?;
            Ok((held, narsil.count_documents(&case.index)?))
        })();
        narsil.shutdown()?;
        outcome
    })();
    match opened {
        Ok((held, count)) => Outcome::Opened(held, count),
        Err(error) => Outcome::Refused(error.code().as_str().to_string()),
    }
}

#[test]
fn every_damaged_checkpoint_gets_the_reference_outcome_through_a_full_open() {
    let cases = checkpoint_cases();
    assert!(
        cases.len() > 100,
        "cases.json lists {} checkpoint cases",
        cases.len()
    );
    let mut problems = Vec::new();
    for case in &cases {
        let expected = case.documents.as_deref().map(expected_documents);
        let ids: Vec<String> = expected
            .iter()
            .flat_map(|documents| documents.keys().cloned())
            .collect();
        let problem = match (open_case(case, &ids), &case.code, &expected) {
            (Outcome::Refused(found), Some(code), _) if &found == code => None,
            (Outcome::Opened(held, count), None, Some(documents))
                if &held == documents && count == documents.len() as u64 =>
            {
                None
            }
            (Outcome::Refused(found), _, _) => Some(format!("refused with {found}")),
            (Outcome::Opened(_, count), Some(code), _) => Some(format!(
                "opened with {count} documents where the reference refuses with {code}"
            )),
            (Outcome::Opened(_, count), None, _) => {
                Some(format!("opened with other documents ({count})"))
            }
        };
        if let Some(problem) = problem {
            problems.push(format!("{}: {problem}", case.name));
        }
    }
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

fn opened_earlier_products(overlay: Option<&Path>) -> narsil::Result<(BTreeMap<String, Map>, u64)> {
    let root = ScratchDirectory::new("earlier");
    copy_tree(&samples().join("earlier-releases/0.3.0/wal"), root.path());
    if let Some(graph) = overlay {
        place(&root.path().join("products"), EARLIER_GRAPH_KEY, graph);
    }
    let expected = expected_documents("earlier-releases/0.3.0/expected/checkpoint-products.json");
    let ids: Vec<String> = expected.keys().cloned().collect();
    let narsil = Narsil::open(log_tier(root.path()))?;
    search_every_vector_field(&narsil, "products")?;
    let held = held_documents(&narsil, "products", &ids)?;
    let count = narsil.count_documents("products")?;
    narsil.shutdown()?;
    Ok((held, count))
}

#[test]
fn an_earlier_graph_file_edited_to_m_one_refuses_the_open() {
    let (held, count) = opened_earlier_products(None).expect("the untouched 0.3.0 directory opens");
    let expected = expected_documents("earlier-releases/0.3.0/expected/checkpoint-products.json");
    assert_eq!(count, expected.len() as u64);
    assert_eq!(held, expected);
    let damaged = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/earlier-graph-m-below-two")
        .join(EARLIER_GRAPH_KEY);
    let refused = opened_earlier_products(Some(&damaged))
        .err()
        .map(|error| error.code().as_str());
    assert_eq!(refused, Some("PERSISTENCE_LOAD_FAILED"));
}

#[test]
fn every_earlier_release_directory_opens_with_the_documents_that_the_reference_recovers() {
    let releases = [
        (
            "earlier-releases/0.3.0/wal",
            false,
            vec![
                (
                    "notes",
                    "earlier-releases/0.3.0/expected/checkpoint-notes.json",
                ),
                (
                    "products",
                    "earlier-releases/0.3.0/expected/checkpoint-products.json",
                ),
            ],
        ),
        (
            "earlier-releases/0.3.0/snapshot-tier",
            true,
            vec![(
                "products",
                "earlier-releases/0.3.0/expected/snapshot-bundle-products.json",
            )],
        ),
        (
            "earlier-releases/0.3.0/snapshot-tier-numeric-ids",
            true,
            vec![(
                "pantry",
                "earlier-releases/0.3.0/expected/snapshot-bundle-pantry.json",
            )],
        ),
    ];
    for (path, snapshot, indexes) in releases {
        let root = ScratchDirectory::new("release");
        copy_tree(&samples().join(path), root.path());
        for open in [
            "first open, which upgrades the layout",
            "reopen of the upgraded layout",
        ] {
            let config = if snapshot {
                snapshot_tier(root.path())
            } else {
                log_tier(root.path())
            };
            let narsil =
                Narsil::open(config).unwrap_or_else(|error| panic!("{path}, {open}: {error}"));
            for (index, expected_path) in &indexes {
                let expected = expected_documents(expected_path);
                let ids: Vec<String> = expected.keys().cloned().collect();
                search_every_vector_field(&narsil, index).expect("every vector field searches");
                let held = held_documents(&narsil, index, &ids).expect("the documents read");
                let count = narsil.count_documents(index).expect("the count reads");
                assert_eq!(count, expected.len() as u64, "{path} {index}, {open}");
                assert!(held == expected, "{path} {index}, {open}: other documents");
            }
            narsil.shutdown().expect("the engine shuts down");
        }
    }
}
