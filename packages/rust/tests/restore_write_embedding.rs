mod support;

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Weak, mpsc};
use std::time::Duration;

use narsil::{
    AdapterSetting, EmbeddingConfig, ErrorCode, IndexConfig, Map, Narsil, Value, parse_json,
};
use support::adapters::EmbedWith;
use support::portable::snapshot_of;

const INDEX: &str = "documents";
const DEADLINE: Duration = Duration::from_secs(10);
const EMBEDDINGS_BEFORE_REFUSAL: usize = 3;
const WRITER: &str = "writer";
const ONLY_IN_ARCHIVE: &str = "restored-only";
const IN_BOTH_INDEXES: &str = "shared";
const ONLY_IN_REPLACED: &str = "replaced-only";
const UPDATED_TITLE: &str = "updated shared title";
const FRESH_TITLES: [&str; 3] = ["fresh first", "fresh second", "fresh third"];
const WANTED_VECTOR: [f32; 2] = [0.0, 1.0];
const DECOY_VECTOR: [f32; 2] = [1.0, 0.0];

#[derive(Clone, Copy, Debug)]
enum WriteKind {
    Insert,
    Update,
    InsertBatch,
    UpdateBatch,
}

fn config(adapter: &str) -> IndexConfig {
    IndexConfig {
        schema: parse_json(r#"{"title":"string","embedding":"vector[2]"}"#).unwrap(),
        embedding: Some(EmbeddingConfig {
            fields: vec![("embedding".into(), vec!["title".into()])],
            adapter: Some(AdapterSetting::Named(adapter.into())),
        }),
        ..IndexConfig::default()
    }
}

fn titled(title: &str) -> Map {
    let mut document = Map::new();
    document.insert("title", Value::String(title.into()));
    document
}

fn embedded(title: &str, vector: [f32; 2]) -> Map {
    let mut document = titled(title);
    document.insert(
        "embedding",
        Value::Array(
            vector
                .into_iter()
                .map(|value| Value::Number(f64::from(value)))
                .collect(),
        ),
    );
    document
}

fn fixed_adapter() -> Arc<dyn narsil::EmbeddingAdapter> {
    Arc::new(EmbedWith {
        dimensions: WANTED_VECTOR.len(),
        embed: |_: &str| Ok(WANTED_VECTOR.to_vec()),
    })
}

fn archive_bound_to(adapter: &str, ids: &[&str]) -> Vec<u8> {
    let source = Narsil::new();
    source
        .register_embedding_adapter(adapter, fixed_adapter())
        .unwrap();
    source.create_index(INDEX, config(adapter)).unwrap();
    for id in ids {
        source
            .insert(INDEX, embedded(id, WANTED_VECTOR), Some(id))
            .unwrap();
    }
    snapshot_of(&source, INDEX)
}

fn written(kind: WriteKind) -> BTreeMap<String, String> {
    match kind {
        WriteKind::Insert => BTreeMap::from([(FRESH_TITLES[0].into(), FRESH_TITLES[0].into())]),
        WriteKind::InsertBatch => FRESH_TITLES
            .iter()
            .map(|title| ((*title).to_string(), (*title).to_string()))
            .collect(),
        WriteKind::Update | WriteKind::UpdateBatch => {
            BTreeMap::from([(IN_BOTH_INDEXES.into(), UPDATED_TITLE.into())])
        }
    }
}

fn whole_batch(outcome: narsil::Result<narsil::BatchResult>) -> narsil::Result<()> {
    let result = outcome?;
    match result.failed.into_iter().next() {
        Some(failure) => Err(failure.error),
        None => Ok(()),
    }
}

fn write(engine: &Narsil, kind: WriteKind) -> narsil::Result<()> {
    match kind {
        WriteKind::Insert => engine
            .insert(INDEX, titled(FRESH_TITLES[0]), Some(FRESH_TITLES[0]))
            .map(|_| ()),
        WriteKind::Update => engine.update(INDEX, IN_BOTH_INDEXES, titled(UPDATED_TITLE)),
        WriteKind::InsertBatch => {
            let documents = FRESH_TITLES
                .iter()
                .map(|title| {
                    let mut document = titled(title);
                    document.insert("id", Value::String((*title).into()));
                    document
                })
                .collect();
            whole_batch(engine.insert_batch(INDEX, documents))
        }
        WriteKind::UpdateBatch => whole_batch(
            engine.update_batch(INDEX, vec![(IN_BOTH_INDEXES.into(), titled(UPDATED_TITLE))]),
        ),
    }
}

fn write_within_deadline(engine: &Arc<Narsil>, kind: WriteKind) -> narsil::Result<()> {
    let (finished, outcome) = mpsc::channel();
    let writing = Arc::clone(engine);
    std::thread::spawn(move || {
        let _ = finished.send(write(&writing, kind));
    });
    outcome.recv_timeout(DEADLINE).unwrap_or_else(|_| {
        panic!("the {kind:?} write did not return while its embedding adapter restored the index")
    })
}

fn restoring_adapter(
    engine: Weak<Narsil>,
    archive: Vec<u8>,
    embeddings: Arc<AtomicUsize>,
    restores: usize,
) -> Arc<dyn narsil::EmbeddingAdapter> {
    Arc::new(EmbedWith {
        dimensions: WANTED_VECTOR.len(),
        embed: move |_: &str| {
            if embeddings.fetch_add(1, Ordering::SeqCst) < restores {
                engine
                    .upgrade()
                    .unwrap()
                    .restore(INDEX, &mut archive.as_slice())?;
            }
            Ok(WANTED_VECTOR.to_vec())
        },
    })
}

fn require_stored(engine: &Narsil, id: &str, title: &str) {
    let mut stored = engine
        .get(INDEX, id)
        .unwrap()
        .unwrap_or_else(|| panic!("document {id} is missing from the restored index"));
    if let Some(Value::String(own_id)) = stored.remove("id") {
        assert_eq!(own_id, id, "the id field of document {id}");
    }
    assert_eq!(stored, embedded(title, WANTED_VECTOR), "document {id}");
}

fn require_write_in_the_restored_index(kind: WriteKind) {
    let archive = archive_bound_to(WRITER, &[ONLY_IN_ARCHIVE, IN_BOTH_INDEXES]);
    let target = Arc::new(Narsil::new());
    let embeddings = Arc::new(AtomicUsize::new(0));
    let adapter = restoring_adapter(Arc::downgrade(&target), archive, Arc::clone(&embeddings), 1);
    target.register_embedding_adapter(WRITER, adapter).unwrap();
    target.create_index(INDEX, config(WRITER)).unwrap();
    for id in [ONLY_IN_REPLACED, IN_BOTH_INDEXES] {
        target
            .insert(INDEX, embedded(id, DECOY_VECTOR), Some(id))
            .unwrap();
    }

    if let Err(error) = write_within_deadline(&target, kind) {
        panic!("the {kind:?} write failed: {error}");
    }

    assert!(embeddings.load(Ordering::SeqCst) > 0);
    let written = written(kind);
    for (id, title) in &written {
        require_stored(&target, id, title);
    }
    require_stored(&target, ONLY_IN_ARCHIVE, ONLY_IN_ARCHIVE);
    if !written.contains_key(IN_BOTH_INDEXES) {
        require_stored(&target, IN_BOTH_INDEXES, IN_BOTH_INDEXES);
    }
    assert_eq!(target.get(INDEX, ONLY_IN_REPLACED).unwrap(), None);
    let added = match written.contains_key(IN_BOTH_INDEXES) {
        true => 0,
        false => written.len() as u64,
    };
    assert_eq!(target.count_documents(INDEX).unwrap(), 2 + added);
}

fn require_refusal_after_alternating_adapters(kind: WriteKind) {
    let bound_to_second = archive_bound_to("second", &[ONLY_IN_ARCHIVE, IN_BOTH_INDEXES]);
    let bound_to_first = archive_bound_to("first", &[ONLY_IN_ARCHIVE, IN_BOTH_INDEXES]);
    let target = Arc::new(Narsil::new());
    let embeddings = Arc::new(AtomicUsize::new(0));
    for (adapter, archive) in [("first", bound_to_second), ("second", bound_to_first)] {
        let restoring = restoring_adapter(
            Arc::downgrade(&target),
            archive,
            Arc::clone(&embeddings),
            usize::MAX,
        );
        target
            .register_embedding_adapter(adapter, restoring)
            .unwrap();
    }
    target.create_index(INDEX, config("first")).unwrap();
    target
        .insert(
            INDEX,
            embedded(IN_BOTH_INDEXES, DECOY_VECTOR),
            Some(IN_BOTH_INDEXES),
        )
        .unwrap();

    let Err(error) = write_within_deadline(&target, kind) else {
        panic!("the {kind:?} write applied while restores kept changing its adapter");
    };

    assert_eq!(error.code(), ErrorCode::WORKER_BUSY, "{kind:?}: {error}");
    let written = written(kind);
    assert_eq!(
        embeddings.load(Ordering::SeqCst),
        EMBEDDINGS_BEFORE_REFUSAL * written.len(),
        "{kind:?}"
    );
    for id in written.keys() {
        if id != IN_BOTH_INDEXES {
            assert_eq!(
                target.get(INDEX, id).unwrap(),
                None,
                "the refused write stored {id}"
            );
        }
    }
    require_stored(&target, IN_BOTH_INDEXES, IN_BOTH_INDEXES);
    require_stored(&target, ONLY_IN_ARCHIVE, ONLY_IN_ARCHIVE);
}

#[test]
fn an_insert_whose_embedding_adapter_restores_the_index_lands_whole_in_the_restored_index() {
    require_write_in_the_restored_index(WriteKind::Insert);
}

#[test]
fn an_update_whose_embedding_adapter_restores_the_index_lands_whole_in_the_restored_index() {
    require_write_in_the_restored_index(WriteKind::Update);
}

#[test]
fn a_batch_insert_whose_embedding_adapter_restores_the_index_lands_whole_in_the_restored_index() {
    require_write_in_the_restored_index(WriteKind::InsertBatch);
}

#[test]
fn a_batch_update_whose_embedding_adapter_restores_the_index_lands_whole_in_the_restored_index() {
    require_write_in_the_restored_index(WriteKind::UpdateBatch);
}

#[test]
fn an_insert_refuses_with_worker_busy_once_restores_keep_changing_its_embedding_adapter() {
    require_refusal_after_alternating_adapters(WriteKind::Insert);
}

#[test]
fn an_update_refuses_with_worker_busy_once_restores_keep_changing_its_embedding_adapter() {
    require_refusal_after_alternating_adapters(WriteKind::Update);
}

#[test]
fn a_batch_insert_refuses_with_worker_busy_once_restores_keep_changing_its_embedding_adapter() {
    require_refusal_after_alternating_adapters(WriteKind::InsertBatch);
}

#[test]
fn a_batch_update_refuses_with_worker_busy_once_restores_keep_changing_its_embedding_adapter() {
    require_refusal_after_alternating_adapters(WriteKind::UpdateBatch);
}
