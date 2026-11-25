#![cfg(any(target_os = "linux", target_os = "macos", windows))]

use std::collections::HashSet;
use std::sync::Mutex;

use narsil::replication::PartitionCopies;
use narsil::{
    BatchFailure, ErrorCode, IndexConfig, Map, MemoryConfig, Narsil, NarsilConfig, NarsilError,
    Value,
};

const INDEX: &str = "manuals";
const BALLAST_BYTES: usize = 512 * 1024 * 1024;
const HEADROOM_BYTES: f64 = 256.0 * 1024.0 * 1024.0;
const RESUME_HEADROOM_BYTES: f64 = HEADROOM_BYTES / 2.0;
const FILLING_TOKENS: usize = 650_000;
const EXCEEDING_TOKENS: usize = 2_400_000;
const TOKEN_LETTERS: usize = 5;
const BATCH_DOCUMENTS: usize = 1_500;
const FILLING_POSITION: usize = 3;
const ENTRY_BYTES: u64 = 512;
const PROPERTY_BYTES: u64 = 128;
const VALUE_BYTES: u64 = 128;
const BYTES_PER_STRING_BYTE: u64 = 3;
const BYTES_PER_DISTINCT_TERM: u64 = 512;
const BYTES_PER_TERM_UNIT: u64 = 32;
const WOULD_FILL_KEYS: [&str; 12] = [
    "reason",
    "indexName",
    "documentBytes",
    "projectedBytes",
    "heapBytes",
    "youngHeapBytes",
    "heapBytesBeforeCollection",
    "collectedGarbage",
    "processBytes",
    "youngCeilingBytes",
    "youngReserveBytes",
    "blockBytes",
];
const UNKNOWN_HEAP_KEYS: [&str; 5] = [
    "heapBytes",
    "youngHeapBytes",
    "heapBytesBeforeCollection",
    "youngCeilingBytes",
    "youngReserveBytes",
];

static SERIAL: Mutex<()> = Mutex::new(());

struct Figures {
    process_bytes: f64,
    limit_bytes: f64,
}

fn index_config() -> IndexConfig {
    let mut schema = Map::new();
    schema.insert("title", Value::String("string".into()));
    IndexConfig {
        schema: Value::Object(schema),
        ..IndexConfig::default()
    }
}

fn number_of(details: &Map, key: &str) -> f64 {
    details
        .get(key)
        .and_then(Value::as_f64)
        .unwrap_or_else(|| panic!("the details hold no number at {key}: {details:?}"))
}

fn process_figures() -> Option<Figures> {
    let engine = Narsil::open(NarsilConfig {
        memory: Some(MemoryConfig {
            block_writes_above: Some(1e-12),
            resume_writes_below: Some(1e-13),
        }),
        ..NarsilConfig::default()
    })
    .expect("the engine opens");
    engine.create_index(INDEX, index_config()).expect("created");
    let refused = engine.insert(INDEX, titled("boiler"), Some("probe")).err();
    engine.shutdown().expect("stops");
    let details = refused?.details()?.clone();
    Some(Figures {
        process_bytes: number_of(&details, "processBytes"),
        limit_bytes: number_of(&details, "processLimitBytes"),
    })
}

fn bounded_engine() -> Option<Narsil> {
    let Some(figures) = process_figures() else {
        eprintln!(
            "skipped: this system reports no process memory figures, so the engine bounds no write"
        );
        return None;
    };
    let block = (figures.process_bytes + HEADROOM_BYTES) / figures.limit_bytes;
    let resume = (figures.process_bytes + RESUME_HEADROOM_BYTES) / figures.limit_bytes;
    let engine = Narsil::open(NarsilConfig {
        memory: Some(MemoryConfig {
            block_writes_above: Some(block),
            resume_writes_below: Some(resume),
        }),
        ..NarsilConfig::default()
    })
    .expect("the engine opens");
    engine.create_index(INDEX, index_config()).expect("created");
    Some(engine)
}

fn titled(title: &str) -> Map {
    let mut document = Map::new();
    document.insert("title", Value::String(title.to_string()));
    document
}

fn with_id(id: &str, title: &str) -> Map {
    let mut document = Map::new();
    document.insert("id", Value::String(id.to_string()));
    document.insert("title", Value::String(title.to_string()));
    document
}

fn letters_of(serial: usize) -> String {
    let mut remaining = serial;
    let mut letters = vec![b'a'; TOKEN_LETTERS];
    for slot in letters.iter_mut().rev() {
        *slot = b'a' + (remaining % 26) as u8;
        remaining /= 26;
    }
    String::from_utf8(letters).expect("ASCII letters")
}

fn distinct_text(tokens: usize) -> String {
    let mut text = String::with_capacity(tokens * (TOKEN_LETTERS + 1));
    for serial in 0..tokens {
        if serial > 0 {
            text.push(' ');
        }
        text.push_str(&letters_of(serial));
    }
    text
}

fn string_bytes(text: &str) -> u64 {
    text.len() as u64 * BYTES_PER_STRING_BYTE
}

fn expected_document_bytes(document: &Map) -> u64 {
    let mut bytes = ENTRY_BYTES;
    for (key, value) in document.iter() {
        let text = value.as_str().expect("the test writes string values only");
        bytes += PROPERTY_BYTES + string_bytes(key) + VALUE_BYTES + string_bytes(text);
    }
    let title = document
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let tokens: Vec<&str> = title.split_whitespace().collect();
    let distinct: HashSet<&str> = tokens.iter().copied().collect();
    let units: u64 = tokens.iter().map(|token| token.len() as u64).sum();
    bytes + distinct.len() as u64 * BYTES_PER_DISTINCT_TERM + units * BYTES_PER_TERM_UNIT
}

fn details_of(error: &NarsilError) -> &Map {
    assert_eq!(error.code(), ErrorCode::MEMORY_WRITE_BLOCKED, "{error:?}");
    error.details().expect("the refusal carries details")
}

fn assert_would_fill(error: &NarsilError, document: &Map) {
    let details = details_of(error);
    let keys: Vec<&str> = details.iter().map(|(key, _)| key.as_str()).collect();
    assert_eq!(keys, WOULD_FILL_KEYS, "{details:?}");
    assert_eq!(
        details.get("reason"),
        Some(&Value::from("write_would_fill_memory"))
    );
    assert_eq!(details.get("indexName"), Some(&Value::from(INDEX)));
    for key in UNKNOWN_HEAP_KEYS {
        assert_eq!(details.get(key), Some(&Value::Null), "{key}");
    }
    assert!(
        matches!(details.get("collectedGarbage"), Some(Value::Bool(_))),
        "{details:?}"
    );
    let document_bytes = number_of(details, "documentBytes");
    let projected_bytes = number_of(details, "projectedBytes");
    let process_bytes = number_of(details, "processBytes");
    let block_bytes = number_of(details, "blockBytes");
    assert_eq!(
        document_bytes,
        expected_document_bytes(document) as f64,
        "{details:?}"
    );
    assert!(document_bytes <= block_bytes, "{details:?}");
    assert!(
        document_bytes + projected_bytes + process_bytes > block_bytes,
        "{details:?}"
    );
    assert!(
        error.message().starts_with(&format!(
            "The engine refuses this document for index '{INDEX}' because indexing it can take up to {document_bytes} bytes"
        )),
        "{}",
        error.message()
    );
}

fn assert_refused_after(failure: &BatchFailure, doc_id: &str, refused_doc_id: &str) {
    assert_eq!(failure.doc_id, doc_id);
    let details = details_of(&failure.error);
    let expected: Map = [
        ("reason", Value::from("write_would_fill_memory")),
        ("indexName", Value::from(INDEX)),
        ("docId", Value::from(doc_id)),
        ("refusedDocId", Value::from(refused_doc_id)),
    ]
    .into_iter()
    .collect();
    assert_eq!(details, &expected);
}

fn small_title(serial: usize) -> String {
    format!("boiler valve pressure {}", letters_of(serial))
}

#[test]
fn an_insert_and_an_update_whose_bound_would_fill_memory_are_refused_and_change_nothing() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let ballast = std::hint::black_box(vec![1u8; BALLAST_BYTES]);
    let Some(engine) = bounded_engine() else {
        return;
    };
    let filling = titled(&distinct_text(FILLING_TOKENS));
    let refused = engine
        .insert(INDEX, filling.clone(), Some("filling"))
        .expect_err("the bound passes the block fraction");
    assert_would_fill(&refused, &filling);
    assert_eq!(number_of(details_of(&refused), "projectedBytes"), 0.0);
    assert!(!engine.has(INDEX, "filling").expect("read"));
    engine
        .insert(INDEX, titled("boiler valve"), Some("kept"))
        .expect("a small insert fits once the refusal clears");
    let refused = engine
        .update(INDEX, "kept", filling.clone())
        .expect_err("the bound passes the block fraction");
    assert_would_fill(&refused, &filling);
    let stored = engine.get(INDEX, "kept").expect("read").expect("kept");
    assert_eq!(stored.get("title"), Some(&Value::from("boiler valve")));
    engine
        .remove(INDEX, "kept")
        .expect("a remove stays unbounded");
    engine.shutdown().expect("stops");
    drop(ballast);
}

#[test]
fn a_document_larger_than_the_block_is_refused_as_exceeding_memory() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let ballast = std::hint::black_box(vec![1u8; BALLAST_BYTES]);
    let Some(engine) = bounded_engine() else {
        return;
    };
    let text = distinct_text(EXCEEDING_TOKENS);
    let exceeding = titled(&text);
    let refused = engine
        .insert(INDEX, exceeding.clone(), Some("exceeding"))
        .expect_err("the bound passes the whole block");
    let details = details_of(&refused);
    let keys: Vec<&str> = details.iter().map(|(key, _)| key.as_str()).collect();
    assert_eq!(keys, ["reason", "indexName", "documentBytes", "blockBytes"]);
    assert_eq!(
        details.get("reason"),
        Some(&Value::from("write_exceeds_memory"))
    );
    assert_eq!(details.get("indexName"), Some(&Value::from(INDEX)));
    let document_bytes = number_of(details, "documentBytes");
    assert_eq!(document_bytes, expected_document_bytes(&exceeding) as f64);
    assert!(
        document_bytes > number_of(details, "blockBytes"),
        "{details:?}"
    );
    drop(exceeding);
    engine.shutdown().expect("stops");
    drop(engine);
    let Some(engine) = bounded_engine() else {
        return;
    };
    let batch = engine
        .insert_batch(INDEX, vec![with_id("exceeding", &text)])
        .expect("the batch answers");
    assert!(batch.succeeded.is_empty());
    let [failure] = batch.failed.as_slice() else {
        panic!("one refusal: {:?}", batch.failed.len());
    };
    assert_eq!(failure.doc_id, "exceeding");
    assert_eq!(
        details_of(&failure.error).get("reason"),
        Some(&Value::from("write_exceeds_memory"))
    );
    assert_eq!(engine.count_documents(INDEX).expect("counted"), 0);
    engine.shutdown().expect("stops");
    drop(ballast);
}

#[test]
fn a_batch_insert_keeps_the_documents_before_the_one_that_would_fill_memory() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let ballast = std::hint::black_box(vec![1u8; BALLAST_BYTES]);
    let Some(engine) = bounded_engine() else {
        return;
    };
    let ids: Vec<String> = (0..BATCH_DOCUMENTS)
        .map(|serial| format!("part-{serial}"))
        .collect();
    let filling = with_id(&ids[FILLING_POSITION], &distinct_text(FILLING_TOKENS));
    let documents: Vec<Map> = ids
        .iter()
        .enumerate()
        .map(|(serial, id)| match serial == FILLING_POSITION {
            true => filling.clone(),
            false => with_id(id, &small_title(serial)),
        })
        .collect();
    let result = engine
        .insert_batch(INDEX, documents)
        .expect("the batch answers");
    assert_eq!(result.succeeded, ids[..FILLING_POSITION]);
    assert_eq!(result.failed.len(), BATCH_DOCUMENTS - FILLING_POSITION);
    let (first, later) = result.failed.split_first().expect("a refusal");
    assert_eq!(first.doc_id, ids[FILLING_POSITION]);
    assert_would_fill(&first.error, &filling);
    for (failure, id) in later.iter().zip(&ids[FILLING_POSITION + 1..]) {
        assert_refused_after(failure, id, &ids[FILLING_POSITION]);
    }
    assert_eq!(
        engine.count_documents(INDEX).expect("counted"),
        FILLING_POSITION as u64
    );
    for id in &ids[..FILLING_POSITION] {
        assert!(engine.has(INDEX, id).expect("read"), "{id}");
    }
    engine.shutdown().expect("stops");
    drop(ballast);
}

#[test]
fn a_batch_update_keeps_the_updates_before_the_one_that_would_fill_memory() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let ballast = std::hint::black_box(vec![1u8; BALLAST_BYTES]);
    let Some(engine) = bounded_engine() else {
        return;
    };
    let ids = ["pump", "flue", "vent", "drain"];
    let inserted = engine
        .insert_batch(
            INDEX,
            ids.iter().map(|id| with_id(id, "copper pipe")).collect(),
        )
        .expect("the batch answers");
    assert_eq!(inserted.succeeded, ids);
    let filling = with_id("flue", &distinct_text(FILLING_TOKENS));
    let updates = vec![
        ("pump".to_string(), with_id("pump", "brass fitting")),
        ("flue".to_string(), filling.clone()),
        ("vent".to_string(), with_id("vent", "brass fitting")),
        ("drain".to_string(), with_id("drain", "brass fitting")),
    ];
    let result = engine
        .update_batch(INDEX, updates)
        .expect("the batch answers");
    assert_eq!(result.succeeded, ["pump"]);
    let [first, vent, drain] = result.failed.as_slice() else {
        panic!("three refusals: {:?}", result.failed.len());
    };
    assert_eq!(first.doc_id, "flue");
    assert_would_fill(&first.error, &filling);
    assert_refused_after(vent, "vent", "flue");
    assert_refused_after(drain, "drain", "flue");
    let titles: Vec<Option<Value>> = ids
        .iter()
        .map(|id| {
            let stored = engine.get(INDEX, id).expect("read").expect("stored");
            stored.get("title").cloned()
        })
        .collect();
    let expected = ["brass fitting", "copper pipe", "copper pipe", "copper pipe"];
    assert_eq!(titles, expected.map(|title| Some(Value::from(title))));
    engine.shutdown().expect("stops");
    drop(ballast);
}

const CONCURRENT_WRITERS: usize = 8;
const INSERTS_PER_WRITER: usize = 2_000;

#[test]
fn concurrent_inserts_into_separate_indexes_leave_no_memory_reserved_once_they_finish() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(engine) = bounded_engine() else {
        return;
    };
    let indexes: Vec<String> = (0..CONCURRENT_WRITERS)
        .map(|writer| format!("{INDEX}-{writer}"))
        .collect();
    for index in &indexes {
        engine.create_index(index, index_config()).expect("created");
    }
    std::thread::scope(|scope| {
        for index in &indexes {
            let engine = &engine;
            scope.spawn(move || {
                for serial in 0..INSERTS_PER_WRITER {
                    engine
                        .insert(index, titled(&small_title(serial)), None)
                        .expect("a small insert fits");
                }
            });
        }
    });
    for index in &indexes {
        assert_eq!(
            engine.count_documents(index).expect("counted"),
            INSERTS_PER_WRITER as u64
        );
    }
    assert_eq!(
        PartitionCopies::new(&engine).reserved_memory_bytes(),
        0,
        "every finished write gives back exactly the bytes that it reserved"
    );
    engine.shutdown().expect("stops");
}
