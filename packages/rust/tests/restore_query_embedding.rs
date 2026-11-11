mod support;

use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use narsil::{
    AdapterSetting, EmbeddingConfig, IndexConfig, Map, Narsil, QueryParams, Storage, Value,
    VectorQuery, parse_json,
};
use support::ScratchDirectory;
use support::adapters::EmbedWith;
use support::portable::{Tier, snapshot_of};

const INDEX: &str = "documents";
const WAIT: Duration = Duration::from_secs(15);

fn config(adapter: &str) -> IndexConfig {
    IndexConfig {
        schema: parse_json(r#"{"title":"string","embedding":"vector[2]"}"#)
            .expect("the schema is valid"),
        text_storage: Some(Storage::Disk),
        embedding: Some(EmbeddingConfig {
            fields: vec![("embedding".into(), vec!["title".into()])],
            adapter: Some(AdapterSetting::Named(adapter.into())),
        }),
        ..IndexConfig::default()
    }
}

fn insert(engine: &Narsil, id: &str, vector: [f64; 2]) {
    let mut document = Map::new();
    document.insert("id", Value::String(id.into()));
    document.insert("title", Value::String(id.into()));
    document.insert(
        "embedding",
        Value::Array(vector.into_iter().map(Value::Number).collect()),
    );
    engine
        .insert(INDEX, document, None)
        .expect("the insert succeeds");
}

fn register_replacement(engine: &Narsil) {
    engine
        .register_embedding_adapter(
            "replacement",
            Arc::new(EmbedWith {
                dimensions: 2,
                embed: |_: &str| Ok(vec![0.0, 1.0]),
            }),
        )
        .expect("the replacement adapter registers");
}

fn search_params() -> QueryParams {
    QueryParams {
        vector: Some(VectorQuery {
            field: "embedding".into(),
            text: Some("search".into()),
            similarity: Some(0.9),
            ..VectorQuery::default()
        }),
        ..QueryParams::default()
    }
}

fn during_restore<T: Send>(search: impl FnOnce(&Narsil) -> T + Send) -> T {
    let source_root = ScratchDirectory::new("restore-query-embedding-source");
    let source = Tier::Log.open(source_root.path());
    register_replacement(&source);
    source.create_index(INDEX, config("replacement")).unwrap();
    insert(&source, "wanted", [0.0, 1.0]);
    insert(&source, "decoy-one", [1.0, 0.0]);
    insert(&source, "decoy-two", [1.0, 0.0]);
    let archive = snapshot_of(&source, INDEX);
    source.shutdown().unwrap();

    let root = ScratchDirectory::new("restore-query-embedding-target");
    let target = Tier::Log.open(root.path());
    register_replacement(&target);
    let (entered, entering) = mpsc::channel();
    let (release, released) = mpsc::channel();
    let released = Mutex::new(Some(released));
    target
        .register_embedding_adapter(
            "original",
            Arc::new(EmbedWith {
                dimensions: 2,
                embed: move |_: &str| {
                    if let Some(receiver) = released.lock().unwrap().take() {
                        entered.send(()).unwrap();
                        receiver.recv_timeout(WAIT).unwrap();
                    }
                    Ok(vec![1.0, 0.0])
                },
            }),
        )
        .unwrap();
    target.create_index(INDEX, config("original")).unwrap();
    insert(&target, "wanted", [1.0, 0.0]);
    insert(&target, "decoy-one", [0.0, 1.0]);
    insert(&target, "decoy-two", [0.0, 1.0]);
    target.checkpoint(INDEX).unwrap();

    let result = std::thread::scope(|scope| {
        let query = scope.spawn(|| search(&target));
        entering
            .recv_timeout(WAIT)
            .expect("the query starts embedding");
        target.restore(INDEX, &mut archive.as_slice()).unwrap();
        release.send(()).unwrap();
        query.join().expect("the query finishes")
    });
    let fresh = target.query(INDEX, &search_params()).unwrap();
    assert_eq!(fresh.hits.len(), 1);
    assert_eq!(fresh.hits[0].id, "wanted");
    target.shutdown().unwrap();
    result
}

#[test]
fn a_query_uses_the_embedding_adapter_of_the_index_that_it_searches() {
    let result = during_restore(|engine| engine.query(INDEX, &search_params()).unwrap());
    let ids: Vec<_> = result.hits.iter().map(|hit| hit.id.as_str()).collect();
    assert_eq!(ids, vec!["wanted"]);
}

#[test]
fn a_preflight_uses_the_embedding_adapter_of_the_index_that_it_counts() {
    let result = during_restore(|engine| engine.preflight(INDEX, &search_params()).unwrap());
    assert_eq!(result.count, 1);
}

enum QueryProgress {
    Embedding,
    Finished,
}

fn require_bounded_retries(search: impl FnOnce(&Narsil) -> narsil::Result<()> + Send) {
    const RESTORES_BEFORE_CANCELLATION: usize = 64;
    let source_root = ScratchDirectory::new("restore-query-retry-source");
    let source = Tier::Log.open(source_root.path());
    register_replacement(&source);
    source.create_index(INDEX, config("replacement")).unwrap();
    insert(&source, "wanted", [0.0, 1.0]);
    let archive = snapshot_of(&source, INDEX);
    source.shutdown().unwrap();

    let root = ScratchDirectory::new("restore-query-retry-target");
    let target = Tier::Log.open(root.path());
    let (progress, observed) = mpsc::channel();
    let embedding_progress = progress.clone();
    let (release, released) = mpsc::channel::<bool>();
    let released = Mutex::new(released);
    target
        .register_embedding_adapter(
            "replacement",
            Arc::new(EmbedWith {
                dimensions: 2,
                embed: move |_: &str| {
                    embedding_progress.send(QueryProgress::Embedding).unwrap();
                    if !released.lock().unwrap().recv_timeout(WAIT).unwrap() {
                        return Err(std::io::Error::other(
                            "the test cancelled repeated embeddings",
                        )
                        .into());
                    }
                    Ok(vec![0.0, 1.0])
                },
            }),
        )
        .unwrap();
    target.restore(INDEX, &mut archive.as_slice()).unwrap();
    let mut cancelled = false;
    let mut restores = 0;
    let outcome = std::thread::scope(|scope| {
        let query = scope.spawn(|| {
            let outcome = search(&target);
            progress.send(QueryProgress::Finished).unwrap();
            outcome
        });
        loop {
            match observed.recv_timeout(WAIT).expect("the query makes progress") {
                QueryProgress::Finished => break,
                QueryProgress::Embedding if restores < RESTORES_BEFORE_CANCELLATION => {
                    target.restore(INDEX, &mut archive.as_slice()).unwrap();
                    restores += 1;
                    release.send(true).unwrap();
                }
                QueryProgress::Embedding => {
                    cancelled = true;
                    release.send(false).unwrap();
                }
            }
        }
        query.join().unwrap()
    });
    target.shutdown().unwrap();
    assert!(
        !cancelled,
        "the query only returned after the test cancelled its embedding call following {restores} completed restores: {outcome:?}"
    );
}

#[test]
fn a_query_bounds_reembedding_when_restores_keep_replacing_the_index() {
    require_bounded_retries(|engine| engine.query(INDEX, &search_params()).map(|_| ()));
}

#[test]
fn a_preflight_bounds_reembedding_when_restores_keep_replacing_the_index() {
    require_bounded_retries(|engine| engine.preflight(INDEX, &search_params()).map(|_| ()));
}
