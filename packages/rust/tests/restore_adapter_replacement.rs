mod support;

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use narsil::{
    AdapterSetting, EmbeddingConfig, IndexConfig, Map, Narsil, QueryParams, Storage, Value,
    VectorQuery, parse_json,
};
use support::ScratchDirectory;
use support::adapters::EmbedWith;
use support::portable::{Tier, snapshot_of};

const INDEX: &str = "documents";

fn config(adapter: &str) -> IndexConfig {
    IndexConfig {
        schema: parse_json(r#"{"title":"string","embedding":"vector[2]"}"#).unwrap(),
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
    document.insert("title", Value::String(id.into()));
    document.insert(
        "embedding",
        Value::Array(vector.into_iter().map(Value::Number).collect()),
    );
    engine.insert(INDEX, document, Some(id)).unwrap();
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

fn require_current_adapter(preflight: bool) {
    let root = ScratchDirectory::new("restore-adapter-replacement");
    let source = Tier::Log.open(&root.path().join("source"));
    source
        .register_embedding_adapter(
            "replacement",
            Arc::new(EmbedWith {
                dimensions: 2,
                embed: |_: &str| Ok(vec![0.0, 1.0]),
            }),
        )
        .unwrap();
    source.create_index(INDEX, config("replacement")).unwrap();
    insert(&source, "wanted", [0.0, 1.0]);
    insert(&source, "decoy-one", [1.0, 0.0]);
    insert(&source, "decoy-two", [1.0, 0.0]);
    let archive = snapshot_of(&source, INDEX);
    source.shutdown().unwrap();

    let target = Arc::new(Tier::Log.open(&root.path().join("target")));
    let restoring = Arc::downgrade(&target);
    target
        .register_embedding_adapter(
            "original",
            Arc::new(EmbedWith {
                dimensions: 2,
                embed: move |_: &str| {
                    restoring
                        .upgrade()
                        .unwrap()
                        .restore(INDEX, &mut archive.as_slice())?;
                    Ok(vec![1.0, 0.0])
                },
            }),
        )
        .unwrap();
    let replacing = Arc::downgrade(&target);
    let replacements = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&replacements);
    target
        .register_embedding_adapter(
            "replacement",
            Arc::new(EmbedWith {
                dimensions: 2,
                embed: move |_: &str| {
                    replacing.upgrade().unwrap().register_embedding_adapter(
                        "replacement",
                        Arc::new(EmbedWith {
                            dimensions: 2,
                            embed: |_: &str| Ok(vec![0.0, 1.0]),
                        }),
                    )?;
                    counted.fetch_add(1, Ordering::SeqCst);
                    Ok(vec![1.0, 0.0])
                },
            }),
        )
        .unwrap();
    target.create_index(INDEX, config("original")).unwrap();
    insert(&target, "original", [1.0, 0.0]);
    target.checkpoint(INDEX).unwrap();

    let params = search_params();
    let stale = if preflight {
        let count = target.preflight(INDEX, &params).unwrap().count;
        (Vec::new(), count)
    } else {
        let answer = target.query(INDEX, &params).unwrap();
        let ids: Vec<_> = answer.hits.into_iter().map(|hit| hit.id).collect();
        (ids, answer.count)
    };
    assert_eq!(replacements.load(Ordering::SeqCst), 1);
    let fresh = target.query(INDEX, &params).unwrap();
    assert_eq!(fresh.hits.len(), 1);
    assert_eq!(fresh.hits[0].id, "wanted");
    target.shutdown().unwrap();
    if preflight {
        assert_eq!(stale.1, 1, "the current adapter matches only wanted");
    } else {
        assert_eq!(
            stale.0,
            vec!["wanted"],
            "the current adapter matches wanted"
        );
    }
}

#[test]
fn a_query_rechecks_the_adapter_after_a_restored_adapter_replaces_itself() {
    require_current_adapter(false);
}

#[test]
fn a_preflight_rechecks_the_adapter_after_a_restored_adapter_replaces_itself() {
    require_current_adapter(true);
}
