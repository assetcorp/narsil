mod support;

use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Weak, mpsc};
use std::time::Duration;

use narsil::{
    AdapterSetting, BatchResult, EmbeddingConfig, ErrorCode, IndexConfig, Map, Narsil, Value,
    parse_json,
};
use support::adapters::EmbedWith;
use support::portable::snapshot_of;

const INDEX: &str = "documents";
const WRITER: &str = "writer";
const RESTORED_WRITER: &str = "restored-writer";
const WRITER_FAILURE: &str = "the embedding model is offline";
const DEADLINE: Duration = Duration::from_secs(10);
const ARCHIVED_ID: &str = "archived";
const ARCHIVED_VECTOR: [f32; 2] = [9.0, 9.0];
const VECTOR_FIELD: &str = "embedding";

struct IndexSettings {
    required: &'static [&'static str],
    source: &'static str,
}

struct Submitted {
    id: &'static str,
    fields: &'static [(&'static str, &'static str)],
}

const SUBMITTED: [Submitted; 3] = [
    Submitted {
        id: "without-category",
        fields: &[
            ("title", "lacks category"),
            ("summary", "a summary of the document without a category"),
            ("author", "first author"),
        ],
    },
    Submitted {
        id: "without-author",
        fields: &[
            ("title", "lacks author"),
            ("summary", "a summary without its author"),
            ("category", "guides"),
        ],
    },
    Submitted {
        id: "complete",
        fields: &[
            ("title", "holds every field"),
            ("summary", "complete"),
            ("category", "guides"),
            ("author", "second author"),
        ],
    },
];

fn vector_for(text: &str) -> Vec<f32> {
    vec![text.chars().count() as f32, 1.0]
}

fn vector_value(vector: &[f32]) -> Value {
    Value::Array(
        vector
            .iter()
            .map(|&element| Value::Number(f64::from(element)))
            .collect(),
    )
}

fn config(settings: &IndexSettings, adapter: &str) -> IndexConfig {
    let required: Vec<String> = settings
        .required
        .iter()
        .map(|field| (*field).to_string())
        .collect();
    IndexConfig {
        schema: parse_json(
            r#"{"title":"string","summary":"string","category":"string","author":"string","embedding":"vector[2]"}"#,
        )
        .unwrap(),
        embedding: Some(EmbeddingConfig {
            fields: vec![(VECTOR_FIELD.into(), vec![settings.source.into()])],
            adapter: Some(AdapterSetting::Named(adapter.into())),
        }),
        required: (!required.is_empty()).then_some(required),
        ..IndexConfig::default()
    }
}

fn document_of(submitted: &Submitted) -> Map {
    let mut document = Map::new();
    document.insert("id", Value::String(submitted.id.into()));
    for (field, value) in submitted.fields {
        document.insert(*field, Value::String((*value).into()));
    }
    document
}

fn archived_document() -> Map {
    let mut document = Map::new();
    document.insert("title", Value::String("kept by the archive".into()));
    document.insert("summary", Value::String("archived".into()));
    document.insert("category", Value::String("archive".into()));
    document.insert("author", Value::String("archivist".into()));
    document.insert(VECTOR_FIELD, vector_value(&ARCHIVED_VECTOR));
    document
}

fn length_adapter() -> Arc<dyn narsil::EmbeddingAdapter> {
    Arc::new(EmbedWith {
        dimensions: 2,
        embed: |text: &str| Ok(vector_for(text)),
    })
}

fn archive_with(settings: &IndexSettings, adapter: &str) -> Vec<u8> {
    let source = Narsil::new();
    source
        .register_embedding_adapter(adapter, length_adapter())
        .unwrap();
    source
        .create_index(INDEX, config(settings, adapter))
        .unwrap();
    source
        .insert(INDEX, archived_document(), Some(ARCHIVED_ID))
        .unwrap();
    snapshot_of(&source, INDEX)
}

fn restoring_on_first_embedding(
    engine: Weak<Narsil>,
    archive: Vec<u8>,
    embeddings: Arc<AtomicUsize>,
) -> Arc<dyn narsil::EmbeddingAdapter> {
    Arc::new(EmbedWith {
        dimensions: 2,
        embed: move |text: &str| {
            if embeddings.fetch_add(1, Ordering::SeqCst) == 0 {
                engine
                    .upgrade()
                    .unwrap()
                    .restore(INDEX, &mut archive.as_slice())?;
            }
            Ok(vector_for(text))
        },
    })
}

fn restoring_then_failing(
    engine: Weak<Narsil>,
    archive: Vec<u8>,
) -> Arc<dyn narsil::EmbeddingAdapter> {
    Arc::new(EmbedWith {
        dimensions: 2,
        embed: move |_: &str| {
            engine
                .upgrade()
                .unwrap()
                .restore(INDEX, &mut archive.as_slice())?;
            Err(WRITER_FAILURE.into())
        },
    })
}

fn field_of(submitted: &Submitted, field: &str) -> Option<&'static str> {
    submitted
        .fields
        .iter()
        .find(|(name, _)| *name == field)
        .map(|(_, value)| *value)
}

fn admitted_by_both(submitted: &Submitted, before: &IndexSettings, after: &IndexSettings) -> bool {
    before
        .required
        .iter()
        .chain(after.required)
        .all(|field| field_of(submitted, field).is_some())
}

fn insert_batch_within_deadline(engine: &Arc<Narsil>) -> BatchResult {
    let (finished, outcome) = mpsc::channel();
    let writing = Arc::clone(engine);
    std::thread::spawn(move || {
        let documents = SUBMITTED.iter().map(document_of).collect();
        let _ = finished.send(writing.insert_batch(INDEX, documents));
    });
    outcome
        .recv_timeout(DEADLINE)
        .expect("the batch insert did not return while its embedding adapter restored the index")
        .expect("the batch insert failed as a whole")
}

fn require_restored_batch(before: IndexSettings, after: IndexSettings) {
    let target = Arc::new(Narsil::new());
    let embeddings = Arc::new(AtomicUsize::new(0));
    let adapter = restoring_on_first_embedding(
        Arc::downgrade(&target),
        archive_with(&after, WRITER),
        Arc::clone(&embeddings),
    );
    target.register_embedding_adapter(WRITER, adapter).unwrap();
    target.create_index(INDEX, config(&before, WRITER)).unwrap();

    let result = insert_batch_within_deadline(&target);

    assert!(embeddings.load(Ordering::SeqCst) > 0);
    for id in &result.succeeded {
        let submitted = SUBMITTED
            .iter()
            .find(|submitted| submitted.id == id)
            .unwrap_or_else(|| panic!("the batch acknowledged {id}, which it never received"));
        let source = field_of(submitted, after.source).unwrap_or_default();
        let mut expected = document_of(submitted);
        expected.insert(VECTOR_FIELD, vector_value(&vector_for(source)));
        let stored = target
            .get(INDEX, id)
            .unwrap()
            .unwrap_or_else(|| panic!("acknowledged document {id} is missing"));
        assert_eq!(stored, expected, "acknowledged document {id}");
    }
    let admitted: Vec<&Submitted> = SUBMITTED
        .iter()
        .filter(|submitted| admitted_by_both(submitted, &before, &after))
        .collect();
    let refused: BTreeSet<&str> = SUBMITTED
        .iter()
        .filter(|submitted| !admitted_by_both(submitted, &before, &after))
        .map(|submitted| submitted.id)
        .collect();
    let succeeded: BTreeSet<&str> = result.succeeded.iter().map(String::as_str).collect();
    let expected_succeeded: BTreeSet<&str> =
        admitted.iter().map(|submitted| submitted.id).collect();
    assert_eq!(succeeded, expected_succeeded, "acknowledged documents");
    let failed: BTreeMap<&str, ErrorCode> = result
        .failed
        .iter()
        .map(|failure| (failure.doc_id.as_str(), failure.error.code()))
        .collect();
    let expected_failed: BTreeMap<&str, ErrorCode> = refused
        .iter()
        .map(|id| (*id, ErrorCode::DOC_MISSING_REQUIRED_FIELD))
        .collect();
    assert_eq!(failed, expected_failed, "refused documents");
    for id in &refused {
        assert_eq!(
            target.get(INDEX, id).unwrap(),
            None,
            "refused document {id}"
        );
    }
    let mut archived = target
        .get(INDEX, ARCHIVED_ID)
        .unwrap()
        .expect("the restored index lost the archived document");
    archived.remove("id");
    assert_eq!(archived, archived_document());
    assert_eq!(
        target.count_documents(INDEX).unwrap(),
        1 + admitted.len() as u64
    );
}

#[test]
fn a_batch_insert_keeps_refusing_its_documents_when_the_adapter_fails_after_restoring_another_adapter()
 {
    let unconstrained = IndexSettings {
        required: &[],
        source: "title",
    };
    let target = Arc::new(Narsil::new());
    let failing = restoring_then_failing(
        Arc::downgrade(&target),
        archive_with(&unconstrained, RESTORED_WRITER),
    );
    target.register_embedding_adapter(WRITER, failing).unwrap();
    target
        .register_embedding_adapter(RESTORED_WRITER, length_adapter())
        .unwrap();
    target
        .create_index(INDEX, config(&unconstrained, WRITER))
        .unwrap();

    let result = insert_batch_within_deadline(&target);

    assert_eq!(
        result.succeeded,
        Vec::<String>::new(),
        "acknowledged documents"
    );
    let failed: BTreeMap<&str, ErrorCode> = result
        .failed
        .iter()
        .map(|failure| (failure.doc_id.as_str(), failure.error.code()))
        .collect();
    let expected_failed: BTreeMap<&str, ErrorCode> = SUBMITTED
        .iter()
        .map(|submitted| (submitted.id, ErrorCode::EMBEDDING_FAILED))
        .collect();
    assert_eq!(failed, expected_failed, "refused documents");
    assert_eq!(target.count_documents(INDEX).unwrap(), 1);
}

#[test]
fn a_batch_insert_keeps_refusing_a_document_whose_required_field_a_restore_drops() {
    require_restored_batch(
        IndexSettings {
            required: &["category"],
            source: "title",
        },
        IndexSettings {
            required: &[],
            source: "title",
        },
    );
}

#[test]
fn a_batch_insert_refuses_each_document_that_lacks_a_field_required_before_or_after_a_restore() {
    require_restored_batch(
        IndexSettings {
            required: &["category"],
            source: "title",
        },
        IndexSettings {
            required: &["author"],
            source: "title",
        },
    );
}

#[test]
fn a_batch_insert_embeds_through_the_mapping_of_the_index_that_a_restore_puts_in_place() {
    require_restored_batch(
        IndexSettings {
            required: &["category"],
            source: "title",
        },
        IndexSettings {
            required: &[],
            source: "summary",
        },
    );
}
