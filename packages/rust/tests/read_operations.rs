mod support;

use std::collections::BTreeSet;
use std::path::Path;
use std::process::Command;
use std::sync::Arc;

use narsil::{
    DocumentProjection, DurabilityConfig, DurabilityTier, FilesystemPersistence, IndexConfig,
    ListParams, ListResult, Map, Narsil, NarsilConfig, PartitionConfig, QueryParams, SuggestParams,
    TermMatch, Value, VectorQuery, parse_json, write_json,
};
use support::{ScratchDirectory, repository_root};

const INDEX: &str = "reads";
const DOCUMENT_COUNT: usize = 1_300;
const ID_STRIDE: usize = 7_919;
const ID_SPACE: usize = 100_000;
const REMOVAL_STRIDE: usize = 9;
const WORDS_PER_FIELD: usize = 6;
const DOCS_PER_PARTITION: u64 = 400;
const MAX_PARTITIONS: u64 = 8;
const INSERT_BATCH: usize = 500;
const PAGE_LIMIT: usize = 37;
const SMALL_PAGE_LIMIT: usize = 3;
const MAX_PAGES: usize = 5_000;
const RESULT_WINDOW: usize = 10_000;
const OVERSIZED_CURSOR_UNITS: usize = 50_000;
const VOCABULARY: [&str; 14] = [
    "running",
    "runner",
    "runs",
    "rune",
    "Running",
    "RUNNING",
    "quick",
    "quickly",
    "cat",
    "cats",
    "catalogue",
    "the",
    "résumé",
    "resume",
];
const ODD_IDS: [&str; 8] = [
    "é",
    "Z",
    "a",
    "\u{FF21}",
    "\u{1F600}",
    "日本",
    "doc-",
    "doc-00000-b",
];
const VECTORS: [[f64; 3]; 4] = [
    [0.5, 0.25, -1.0],
    [1.0, 0.0, 0.125],
    [-0.5, 0.75, 0.25],
    [0.0, -0.25, 1.0],
];

fn object(entries: Vec<(&str, Value)>) -> Value {
    let mut map = Map::new();
    for (key, value) in entries {
        map.insert(key, value);
    }
    Value::Object(map)
}

fn text(value: &str) -> Value {
    Value::String(value.to_string())
}

fn number(value: f64) -> Value {
    Value::Number(value)
}

fn vector_of(row: usize) -> Value {
    Value::Array(
        VECTORS[row % VECTORS.len()]
            .iter()
            .map(|v| number(*v))
            .collect(),
    )
}

fn schema() -> Value {
    object(vec![
        ("title", text("string")),
        ("body", text("string")),
        ("rank", text("number")),
        ("meta", object(vec![("tag", text("string"))])),
        ("embedding", text("vector[3]")),
    ])
}

fn crate_config(surface_forms: bool) -> IndexConfig {
    IndexConfig {
        schema: schema(),
        partitions: Some(PartitionConfig {
            max_docs_per_partition: Some(DOCS_PER_PARTITION),
            max_partitions: Some(MAX_PARTITIONS),
            ..PartitionConfig::default()
        }),
        surface_forms: Some(surface_forms),
        ..IndexConfig::default()
    }
}

fn reference_config(surface_forms: bool) -> Value {
    object(vec![
        ("schema", schema()),
        (
            "partitions",
            object(vec![
                ("maxDocsPerPartition", number(DOCS_PER_PARTITION as f64)),
                ("maxPartitions", number(MAX_PARTITIONS as f64)),
            ]),
        ),
        ("surfaceForms", Value::Bool(surface_forms)),
    ])
}

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> usize {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        (self.0 >> 33) as usize
    }

    fn words(&mut self) -> String {
        (0..WORDS_PER_FIELD)
            .map(|_| VOCABULARY[self.next() % VOCABULARY.len()])
            .collect::<Vec<_>>()
            .join(" ")
    }
}

fn corpus() -> Vec<(String, Map)> {
    let mut rng = Rng(0x2545_F491_4F6C_DD1D);
    let mut ids: Vec<String> = (0..DOCUMENT_COUNT)
        .map(|n| format!("doc-{:05}", (n * ID_STRIDE) % ID_SPACE))
        .collect();
    ids.extend(ODD_IDS.iter().map(|id| id.to_string()));
    ids.into_iter()
        .enumerate()
        .map(|(row, id)| {
            let Value::Object(document) = object(vec![
                ("title", text(&rng.words())),
                ("body", text(&rng.words())),
                ("rank", number((rng.next() % 1_000) as f64)),
                (
                    "meta",
                    object(vec![("tag", text(VOCABULARY[row % VOCABULARY.len()]))]),
                ),
                ("embedding", vector_of(row)),
            ]) else {
                unreachable!()
            };
            (id, document)
        })
        .collect()
}

fn removals(corpus: &[(String, Map)]) -> Vec<String> {
    corpus
        .iter()
        .step_by(REMOVAL_STRIDE)
        .map(|(id, _)| id.clone())
        .collect()
}

fn with_id(id: &str, document: &Map) -> Map {
    let mut stored = document.clone();
    stored.insert("id", text(id));
    stored
}

fn loaded(engine: &Narsil, config: IndexConfig, corpus: &[(String, Map)], removed: &[String]) {
    engine
        .create_index(INDEX, config)
        .expect("the index is created");
    let documents: Vec<Map> = corpus
        .iter()
        .map(|(id, document)| with_id(id, document))
        .collect();
    for batch in documents.chunks(INSERT_BATCH) {
        let result = engine
            .insert_batch(INDEX, batch.to_vec())
            .expect("the batch is inserted");
        assert!(
            result.failed.is_empty(),
            "the crate refused {:?}",
            result.failed
        );
    }
    for id in removed {
        engine.remove(INDEX, id).expect("the document is removed");
    }
}

fn reference(
    surface_forms: bool,
    corpus: &[(String, Map)],
    removed: &[String],
    steps: Vec<Value>,
) -> Vec<Value> {
    let documents = corpus
        .iter()
        .map(|(id, document)| Value::Array(vec![text(id), Value::Object(document.clone())]))
        .collect();
    let spec = object(vec![
        ("config", reference_config(surface_forms)),
        ("documents", Value::Array(documents)),
        (
            "removals",
            Value::Array(removed.iter().map(|id| text(id)).collect()),
        ),
        ("steps", Value::Array(steps)),
    ]);
    let scratch = ScratchDirectory::new("reads");
    let spec_path = scratch.path().join("spec.json");
    std::fs::write(&spec_path, write_json(&spec)).expect("the spec is written");
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/support/reference_reads.mjs");
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
    let found = parse_json(&String::from_utf8(output.stdout).expect("UTF-8")).expect("JSON");
    found
        .pointer("results")
        .and_then(Value::as_array)
        .expect("the reference lists its results")
        .clone()
}

fn canonical(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut entries: Vec<(&String, &Value)> = map.iter().collect();
            entries.sort_by(|left, right| left.0.cmp(right.0));
            let mut sorted = Map::new();
            for (key, child) in entries {
                sorted.insert(key.clone(), canonical(child));
            }
            Value::Object(sorted)
        }
        Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
        other => other.clone(),
    }
}

#[derive(Debug, PartialEq)]
enum Page {
    Listed {
        documents: Vec<(String, String)>,
        cursor: Option<String>,
        total: u64,
    },
    Refused {
        code: String,
        message: String,
    },
}

fn crate_page(result: narsil::Result<ListResult>) -> Page {
    match result {
        Ok(page) => Page::Listed {
            documents: page
                .documents
                .into_iter()
                .map(|entry| {
                    (
                        entry.id,
                        write_json(&canonical(&Value::Object(entry.document))),
                    )
                })
                .collect(),
            cursor: page.cursor,
            total: page.total,
        },
        Err(error) => Page::Refused {
            code: error.code().to_string(),
            message: error.message().to_string(),
        },
    }
}

fn refusal(result: &Value) -> Option<(String, String)> {
    let error = result.pointer("error")?;
    let field = |name: &str| {
        error
            .pointer(name)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    Some((field("code"), field("message")))
}

fn reference_page(result: &Value) -> Page {
    if let Some((code, message)) = refusal(result) {
        return Page::Refused { code, message };
    }
    Page::Listed {
        documents: result
            .pointer("documents")
            .and_then(Value::as_array)
            .expect("the page lists its documents")
            .iter()
            .map(|entry| {
                let pair = entry.as_array().expect("an ID and a document");
                (
                    pair[0].as_str().expect("an ID").to_string(),
                    write_json(&canonical(&pair[1])),
                )
            })
            .collect(),
        cursor: result
            .pointer("cursor")
            .and_then(Value::as_str)
            .map(str::to_string),
        total: result
            .pointer("total")
            .and_then(Value::as_f64)
            .expect("a total") as u64,
    }
}

fn reference_pages(result: &Value) -> Vec<Page> {
    assert!(
        refusal(result).is_none(),
        "the reference refused a listing: {result:?}"
    );
    result
        .pointer("pages")
        .and_then(Value::as_array)
        .expect("the pages")
        .iter()
        .map(reference_page)
        .collect()
}

fn crate_pages(engine: &Narsil, params: &ListParams) -> Vec<Page> {
    let mut pages = Vec::new();
    let mut cursor = None;
    for _ in 0..MAX_PAGES {
        let page = crate_page(engine.list_documents(
            INDEX,
            &ListParams {
                cursor,
                ..params.clone()
            },
        ));
        let Page::Listed { cursor: next, .. } = &page else {
            panic!("the crate refused a listing: {page:?}");
        };
        cursor = next.clone();
        pages.push(page);
        if cursor.is_none() {
            return pages;
        }
    }
    panic!("the listing never ended");
}

fn listed_ids(pages: &[Page]) -> Vec<String> {
    pages
        .iter()
        .flat_map(|page| match page {
            Page::Listed { documents, .. } => documents.iter().map(|(id, _)| id.clone()).collect(),
            Page::Refused { .. } => Vec::new(),
        })
        .collect()
}

fn strings(paths: &[&str]) -> Vec<Value> {
    paths.iter().map(|path| text(path)).collect()
}

fn listings() -> Vec<(ListParams, Value)> {
    let limited = |limit: usize| object(vec![("limit", number(limit as f64))]);
    vec![
        (
            ListParams {
                limit: Some(PAGE_LIMIT),
                ..ListParams::default()
            },
            limited(PAGE_LIMIT),
        ),
        (
            ListParams {
                limit: Some(SMALL_PAGE_LIMIT),
                document: Some(DocumentProjection::Fields {
                    include: Some(vec![
                        "title".into(),
                        "meta.tag".into(),
                        "constructor".into(),
                    ]),
                    exclude: None,
                }),
                ..ListParams::default()
            },
            object(vec![
                ("limit", number(SMALL_PAGE_LIMIT as f64)),
                (
                    "document",
                    object(vec![(
                        "include",
                        Value::Array(strings(&["title", "meta.tag", "constructor"])),
                    )]),
                ),
            ]),
        ),
        (
            ListParams {
                limit: Some(PAGE_LIMIT),
                document: Some(DocumentProjection::Fields {
                    include: None,
                    exclude: Some(vec!["embedding".into(), "body".into(), "meta.tag".into()]),
                }),
                ..ListParams::default()
            },
            object(vec![
                ("limit", number(PAGE_LIMIT as f64)),
                (
                    "document",
                    object(vec![(
                        "exclude",
                        Value::Array(strings(&["embedding", "body", "meta.tag"])),
                    )]),
                ),
            ]),
        ),
        (
            ListParams {
                limit: Some(PAGE_LIMIT),
                document: Some(DocumentProjection::None),
                ..ListParams::default()
            },
            object(vec![
                ("limit", number(PAGE_LIMIT as f64)),
                ("document", Value::Bool(false)),
            ]),
        ),
    ]
}

#[test]
fn listing_pages_every_live_document_once_with_the_reference_pages_and_cursors() {
    let corpus = corpus();
    let removed = removals(&corpus);
    let listings = listings();
    let steps = listings
        .iter()
        .map(|(_, params)| object(vec![("kind", text("pages")), ("params", params.clone())]))
        .collect();
    let wanted = reference(true, &corpus, &removed, steps);
    let removed_set: BTreeSet<&String> = removed.iter().collect();
    let live: BTreeSet<String> = corpus
        .iter()
        .map(|(id, _)| id.clone())
        .filter(|id| !removed_set.contains(id))
        .collect();
    let live: Vec<String> = live.into_iter().collect();
    let engine = Narsil::new();
    loaded(&engine, crate_config(true), &corpus, &removed);
    for layout in ["tail segments", "frozen segments"] {
        for ((params, _), expected) in listings.iter().zip(&wanted) {
            let found = crate_pages(&engine, params);
            assert_eq!(
                listed_ids(&found),
                live,
                "{layout}: {params:?} lists every live ID once"
            );
            assert_eq!(
                found,
                reference_pages(expected),
                "{layout}: {params:?} matches the reference"
            );
        }
        engine
            .freeze_tail_segments(INDEX)
            .expect("the tails freeze");
    }
    let stats = engine.get_stats(INDEX).expect("the stats read");
    let partitions = engine
        .get_partition_stats(INDEX)
        .expect("the partition stats read");
    assert_eq!(stats.document_count, live.len() as u64);
    assert_eq!(stats.partition_count, partitions.len());
    assert_eq!(
        partitions
            .iter()
            .map(|partition| partition.document_count)
            .sum::<u64>(),
        live.len() as u64
    );
    assert!(partitions.len() > 1, "the corpus spreads across partitions");
}

fn encoded(text: &str) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes = text.as_bytes();
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let triple = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let joined =
            (u32::from(triple[0]) << 16) | (u32::from(triple[1]) << 8) | u32::from(triple[2]);
        for at in 0..4 {
            if at <= chunk.len() {
                out.push(ALPHABET[((joined >> (18 - 6 * at)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn hostile_cursors(real: &str) -> Vec<String> {
    let mut flipped: Vec<char> = real.chars().collect();
    let middle = flipped.len() / 2;
    flipped[middle] = if flipped[middle] == 'A' { 'B' } else { 'A' };
    let url_safe: String = real
        .chars()
        .map(|c| match c {
            '+' => '-',
            '/' => '_',
            other => other,
        })
        .collect();
    vec![
        String::new(),
        "!!!!".into(),
        "\u{1F600}\u{1F600}".into(),
        encoded("{}"),
        encoded("[]"),
        encoded("not json"),
        encoded("null"),
        encoded(r#"{"v":3,"a":"doc-00010","q":"00000000"}"#),
        encoded(r#"{"v":"4","a":"doc-00010","q":"00000000"}"#),
        encoded(r#"{"v":4,"a":5,"q":"00000000"}"#),
        encoded(r#"{"v":4,"a":"doc-00010","q":"deadbeef"}"#),
        encoded(r#"{"v":4,"a":"doc-00010","q":"00000000","s":1.5}"#),
        encoded(r#"{"v":4,"a":"doc-00010","q":"00000000","k":[1],"o":"x"}"#),
        encoded(r#"{"v":4,"a":"doc-00010","q":"00000000","d":-1}"#),
        encoded(&format!(
            r#"{{"v":4,"a":"{}","q":"00000000"}}"#,
            "x".repeat(600)
        )),
        "A".repeat(OVERSIZED_CURSOR_UNITS),
        flipped.into_iter().collect(),
        url_safe,
        format!("{real}===="),
        real.to_string(),
    ]
}

#[test]
fn listing_refuses_hostile_cursors_and_limits_exactly_as_the_reference_does() {
    let corpus = corpus();
    let removed = removals(&corpus);
    let engine = Narsil::new();
    loaded(&engine, crate_config(true), &corpus, &removed);
    let first = engine
        .list_documents(
            INDEX,
            &ListParams {
                limit: Some(PAGE_LIMIT),
                ..ListParams::default()
            },
        )
        .expect("the first page lists");
    let real = first.cursor.expect("a second page follows");
    let mut cases: Vec<(ListParams, Value)> = hostile_cursors(&real)
        .into_iter()
        .map(|cursor| {
            (
                ListParams {
                    cursor: Some(cursor.clone()),
                    limit: Some(SMALL_PAGE_LIMIT),
                    ..ListParams::default()
                },
                object(vec![
                    ("cursor", text(&cursor)),
                    ("limit", number(SMALL_PAGE_LIMIT as f64)),
                ]),
            )
        })
        .collect();
    for limit in [0, 1, RESULT_WINDOW, RESULT_WINDOW + 1, 1_000_000] {
        cases.push((
            ListParams {
                limit: Some(limit),
                document: Some(DocumentProjection::None),
                ..ListParams::default()
            },
            object(vec![
                ("limit", number(limit as f64)),
                ("document", Value::Bool(false)),
            ]),
        ));
    }
    let steps = cases
        .iter()
        .map(|(_, params)| object(vec![("kind", text("list")), ("params", params.clone())]))
        .collect();
    let wanted = reference(true, &corpus, &removed, steps);
    for ((params, _), expected) in cases.iter().zip(&wanted) {
        let found = crate_page(engine.list_documents(INDEX, params));
        assert_eq!(
            found,
            reference_page(expected),
            "{:?} with limit {:?}",
            params.cursor,
            params.limit
        );
    }
    let huge = engine.list_documents(
        INDEX,
        &ListParams {
            limit: Some(usize::MAX),
            ..ListParams::default()
        },
    );
    assert_eq!(
        huge.expect_err("the limit is refused").code().to_string(),
        "SEARCH_RESULT_WINDOW_EXCEEDED"
    );
}

#[test]
fn empty_and_missing_indexes_answer_without_inventing_documents() {
    let engine = Narsil::new();
    engine
        .create_index(INDEX, crate_config(true))
        .expect("the index is created");
    let page = engine
        .list_documents(INDEX, &ListParams::default())
        .expect("the empty index lists");
    assert!(page.documents.is_empty() && page.cursor.is_none() && page.total == 0);
    let suggested = engine
        .suggest(
            INDEX,
            &SuggestParams {
                prefix: "run".into(),
                limit: Some(usize::MAX),
            },
        )
        .expect("the empty index suggests");
    assert!(suggested.terms.is_empty());
    let counted = engine
        .preflight(
            INDEX,
            &QueryParams {
                term: Some("running".into()),
                ..QueryParams::default()
            },
        )
        .expect("the empty index counts");
    assert_eq!((counted.count, counted.count_exact), (0, true));
    let missing = "absent";
    let codes = [
        engine.list_documents(missing, &ListParams::default()).err(),
        engine.suggest(missing, &SuggestParams::default()).err(),
        engine.preflight(missing, &QueryParams::default()).err(),
        engine.get_stats(missing).err(),
        engine.get_partition_stats(missing).err(),
        engine.clear(missing).err(),
    ];
    for error in codes {
        assert_eq!(
            error.expect("the call fails").code().to_string(),
            "INDEX_NOT_FOUND"
        );
    }
    engine.shutdown().expect("the engine stops");
    let after = engine.get_memory_stats();
    assert_eq!(after.open_index_count, 0);
    assert_eq!(
        engine
            .list_documents(INDEX, &ListParams::default())
            .expect_err("the engine stopped")
            .code()
            .to_string(),
        "INSTANCE_SHUT_DOWN"
    );
}

fn suggestions(engine: &Narsil, prefix: &str, limit: Option<usize>) -> Value {
    match engine.suggest(
        INDEX,
        &SuggestParams {
            prefix: prefix.into(),
            limit,
        },
    ) {
        Ok(result) => object(vec![(
            "terms",
            Value::Array(
                result
                    .terms
                    .into_iter()
                    .map(|term| {
                        Value::Array(vec![
                            text(&term.term),
                            number(term.document_frequency as f64),
                        ])
                    })
                    .collect(),
            ),
        )]),
        Err(error) => object(vec![(
            "error",
            object(vec![
                ("code", text(&error.code().to_string())),
                ("message", text(error.message())),
            ]),
        )]),
    }
}

const SUGGEST_PREFIXES: [&str; 14] = [
    "ru",
    "RUN",
    "runn",
    "  run  ",
    "the quick ca",
    "rés",
    "re",
    "zzz",
    "",
    "   ",
    "!!!",
    "cat",
    "q",
    "Résumé",
];
const SUGGEST_LIMITS: [Option<usize>; 5] = [None, Some(0), Some(1), Some(3), Some(1_000)];

#[test]
fn suggestions_match_the_reference_with_and_without_surface_forms() {
    let corpus = corpus();
    let removed = removals(&corpus);
    let mut cases = Vec::new();
    for prefix in SUGGEST_PREFIXES {
        for limit in SUGGEST_LIMITS {
            cases.push((prefix, limit));
        }
    }
    let steps: Vec<Value> = cases
        .iter()
        .map(|(prefix, limit)| {
            let mut params = vec![("prefix", text(prefix))];
            if let Some(limit) = limit {
                params.push(("limit", number(*limit as f64)));
            }
            object(vec![("kind", text("suggest")), ("params", object(params))])
        })
        .collect();
    for surface_forms in [true, false] {
        let wanted = reference(surface_forms, &corpus, &removed, steps.clone());
        let engine = Narsil::new();
        loaded(&engine, crate_config(surface_forms), &corpus, &removed);
        for layout in ["tail segments", "frozen segments"] {
            for ((prefix, limit), expected) in cases.iter().zip(&wanted) {
                assert_eq!(
                    &suggestions(&engine, prefix, *limit),
                    expected,
                    "{layout}, surface forms {surface_forms}: {prefix:?} with limit {limit:?}"
                );
            }
            engine
                .freeze_tail_segments(INDEX)
                .expect("the tails freeze");
        }
    }
}

fn counted(engine: &Narsil, params: &QueryParams) -> Value {
    match engine.preflight(INDEX, params) {
        Ok(result) => object(vec![
            ("count", number(result.count as f64)),
            ("countExact", Value::Bool(result.count_exact)),
        ]),
        Err(error) => object(vec![(
            "error",
            object(vec![
                ("code", text(&error.code().to_string())),
                ("message", text(error.message())),
            ]),
        )]),
    }
}

fn preflights() -> Vec<(QueryParams, Value)> {
    let term = |value: &str| Some(value.to_string());
    vec![
        (
            QueryParams {
                term: term("running"),
                ..QueryParams::default()
            },
            object(vec![("term", text("running"))]),
        ),
        (
            QueryParams {
                term: term("runing"),
                tolerance: Some(1),
                ..QueryParams::default()
            },
            object(vec![("term", text("runing")), ("tolerance", number(1.0))]),
        ),
        (
            QueryParams {
                term: term("quick cat"),
                term_match: Some(TermMatch::All),
                ..QueryParams::default()
            },
            object(vec![
                ("term", text("quick cat")),
                ("termMatch", text("all")),
            ]),
        ),
        (
            QueryParams {
                term: term("quick"),
                min_score: Some(0.5),
                ..QueryParams::default()
            },
            object(vec![("term", text("quick")), ("minScore", number(0.5))]),
        ),
        (
            QueryParams {
                term: term("\"quick cat\""),
                ..QueryParams::default()
            },
            object(vec![("term", text("\"quick cat\""))]),
        ),
        (
            QueryParams {
                term: term("running"),
                limit: Some(RESULT_WINDOW + 1),
                offset: Some(5),
                ..QueryParams::default()
            },
            object(vec![
                ("term", text("running")),
                ("limit", number((RESULT_WINDOW + 1) as f64)),
                ("offset", number(5.0)),
            ]),
        ),
        (
            QueryParams {
                term: term("running"),
                tolerance: Some(11),
                ..QueryParams::default()
            },
            object(vec![("term", text("running")), ("tolerance", number(11.0))]),
        ),
        (
            QueryParams {
                vector: Some(VectorQuery {
                    field: "embedding".into(),
                    value: Some(vec![0.5, 0.25, -1.0]),
                    ..VectorQuery::default()
                }),
                ..QueryParams::default()
            },
            object(vec![(
                "vector",
                object(vec![("field", text("embedding")), ("value", vector_of(0))]),
            )]),
        ),
        (QueryParams::default(), object(vec![])),
    ]
}

#[test]
fn preflight_counts_match_the_reference() {
    let corpus = corpus();
    let removed = removals(&corpus);
    let cases = preflights();
    let steps = cases
        .iter()
        .map(|(_, params)| {
            object(vec![
                ("kind", text("preflight")),
                ("params", params.clone()),
            ])
        })
        .collect();
    let wanted = reference(true, &corpus, &removed, steps);
    let engine = Narsil::new();
    loaded(&engine, crate_config(true), &corpus, &removed);
    for ((params, _), expected) in cases.iter().zip(&wanted) {
        assert_eq!(&counted(&engine, params), expected, "{params:?}");
    }
}

type TierConfig = fn(&Path) -> NarsilConfig;

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
        persistence: Some(Arc::new(adapter)),
        ..NarsilConfig::default()
    }
}

fn all_ids(engine: &Narsil, index: &str) -> Vec<String> {
    let mut ids = Vec::new();
    let mut cursor = None;
    loop {
        let page = engine
            .list_documents(
                index,
                &ListParams {
                    cursor,
                    limit: Some(RESULT_WINDOW),
                    ..ListParams::default()
                },
            )
            .expect("the index lists");
        ids.extend(page.documents.into_iter().map(|entry| entry.id));
        cursor = page.cursor;
        if cursor.is_none() {
            return ids;
        }
    }
}

fn vector_hits(engine: &Narsil, index: &str) -> Vec<String> {
    let found = engine
        .query(
            index,
            &QueryParams {
                vector: Some(VectorQuery {
                    field: "embedding".into(),
                    value: Some(vec![0.5, 0.25, -1.0]),
                    ..VectorQuery::default()
                }),
                limit: Some(RESULT_WINDOW),
                ..QueryParams::default()
            },
        )
        .expect("the vector search runs");
    let mut ids: Vec<String> = found.hits.into_iter().map(|hit| hit.id).collect();
    ids.sort();
    ids
}

#[test]
fn a_cleared_index_stays_cleared_after_a_restart_under_both_tiers() {
    let corpus = corpus();
    let kept = ["after-1".to_string(), "after-2".to_string()];
    let tiers: [(&str, TierConfig); 2] = [("log", log_tier), ("snapshot", snapshot_tier)];
    for (tier, config_of) in tiers {
        let scratch = ScratchDirectory::new("clear");
        {
            let engine = Narsil::open(config_of(scratch.path())).expect("the engine opens");
            loaded(&engine, crate_config(true), &corpus, &[]);
            engine
                .create_index("emptied", crate_config(true))
                .expect("the second index is created");
            let small: Vec<Map> = corpus[..INSERT_BATCH]
                .iter()
                .map(|(id, document)| with_id(id, document))
                .collect();
            engine
                .insert_batch("emptied", small)
                .expect("the second index fills");
            engine
                .freeze_tail_segments(INDEX)
                .expect("the tails freeze");
            engine.checkpoint(INDEX).expect("the full index is saved");
            if tier == "snapshot" {
                engine
                    .checkpoint("emptied")
                    .expect("the full second index is saved");
            }
            engine.clear(INDEX).expect("the index clears");
            engine.clear("emptied").expect("the second index clears");
            for (row, id) in kept.iter().enumerate() {
                engine
                    .insert(INDEX, corpus[row].1.clone(), Some(id))
                    .expect("a new document goes in");
            }
            if tier == "snapshot" {
                engine
                    .checkpoint(INDEX)
                    .expect("the documents after the clear are saved");
            }
            assert_eq!(all_ids(&engine, INDEX), kept, "{tier}: before the restart");
            engine.shutdown().expect("the engine stops");
        }
        let engine = Narsil::open(config_of(scratch.path())).expect("the engine reopens");
        assert_eq!(
            all_ids(&engine, INDEX),
            kept,
            "{tier}: the cleared documents stay gone"
        );
        assert!(
            all_ids(&engine, "emptied").is_empty(),
            "{tier}: the emptied index stays empty"
        );
        assert_eq!(
            vector_hits(&engine, INDEX),
            kept,
            "{tier}: the cleared vectors stay gone"
        );
        assert!(
            vector_hits(&engine, "emptied").is_empty(),
            "{tier}: no vector outlives the clear"
        );
        let stats = engine.get_stats(INDEX).expect("the stats read");
        assert_eq!(stats.document_count, kept.len() as u64, "{tier}");
        assert_eq!(stats.schema, schema(), "{tier}: the schema survives");
        let suggested = engine
            .suggest(
                INDEX,
                &SuggestParams {
                    prefix: "run".into(),
                    limit: Some(100),
                },
            )
            .expect("the index suggests");
        assert!(
            suggested
                .terms
                .iter()
                .all(|term| term.document_frequency <= kept.len() as u64),
            "{tier}: no cleared word comes back as a completion: {:?}",
            suggested.terms
        );
        engine
            .insert("emptied", with_id("fresh", &corpus[0].1), None)
            .expect("the emptied index takes writes");
        assert_eq!(
            all_ids(&engine, "emptied"),
            vec!["fresh".to_string()],
            "{tier}"
        );
        engine.shutdown().expect("the engine stops");
    }
}
