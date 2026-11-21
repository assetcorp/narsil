mod support;

use std::collections::BTreeMap;
use std::sync::Arc;

use narsil::{
    AdapterError, DocumentProjection, GroupConfig, IndexConfig, ListParams, Map, Narsil,
    QueryParams, RerankConfig, Value, VectorQuery,
};
use support::ScratchDirectory;
use support::adapters::RerankWith;
use support::portable::Tier;

const INDEX: &str = "articles";
const RESTORED: &str = "restored";
const RERANKER: &str = "constant";
const DOCUMENT_COUNT: usize = 12;
const DIMENSIONS: usize = 4;

fn text(value: &str) -> Value {
    Value::String(value.to_string())
}

fn vector(seed: usize, offset: usize) -> Value {
    Value::Array(
        (0..DIMENSIONS)
            .map(|at| Value::Number(((seed * 7 + at * 3 + offset) % 16) as f64 * 0.125 - 1.0))
            .collect(),
    )
}

fn config(return_vectors: Option<bool>) -> IndexConfig {
    let mut meta = Map::new();
    meta.insert("tag", text("string"));
    meta.insert("embedding", Value::String(format!("vector[{DIMENSIONS}]")));
    let mut schema = Map::new();
    schema.insert("title", text("string"));
    schema.insert("meta", Value::Object(meta));
    schema.insert("embedding", Value::String(format!("vector[{DIMENSIONS}]")));
    IndexConfig {
        schema: Value::Object(schema),
        return_vectors,
        ..IndexConfig::default()
    }
}

fn written(with_null_vectors: bool) -> BTreeMap<String, Map> {
    (0..DOCUMENT_COUNT)
        .map(|seed| {
            let id = format!("article-{seed:02}");
            let mut meta = Map::new();
            meta.insert("tag", text(if seed % 2 == 0 { "even" } else { "odd" }));
            match seed % 3 {
                0 => {
                    meta.insert("embedding", vector(seed, 5));
                }
                1 if with_null_vectors => {
                    meta.insert("embedding", Value::Null);
                }
                _ => {}
            }
            let mut document = Map::new();
            document.insert("id", text(&id));
            document.insert("title", text(&format!("harbour lantern {seed}")));
            document.insert("meta", Value::Object(meta));
            match seed % 8 {
                7 if with_null_vectors => {
                    document.insert("embedding", Value::Null);
                }
                3 | 7 => {}
                _ => {
                    document.insert("embedding", vector(seed, 0));
                }
            }
            (id, document)
        })
        .collect()
}

#[derive(Clone, Copy, Debug)]
struct Kept {
    embedding: bool,
    meta_embedding: bool,
}

const NO_VECTOR: Kept = Kept {
    embedding: false,
    meta_embedding: false,
};
const EVERY_VECTOR: Kept = Kept {
    embedding: true,
    meta_embedding: true,
};

fn without_vectors(source: &Map, kept: Kept) -> Map {
    let mut document = source.clone();
    if !kept.embedding {
        document.remove("embedding");
    }
    if !kept.meta_embedding
        && let Some(Value::Object(meta)) = document.get_mut("meta")
    {
        meta.remove("embedding");
    }
    document
}

fn only(source: &Map, keys: &[&str]) -> Map {
    let mut document = Map::new();
    for key in keys {
        if let Some(value) = source.get(key) {
            document.insert(*key, value.clone());
        }
    }
    document
}

fn meta_only(source: &Map, key: &str) -> Map {
    let mut document = Map::new();
    let Some(Value::Object(meta)) = source.get("meta") else {
        return document;
    };
    let Some(value) = meta.get(key) else {
        return document;
    };
    let mut kept = Map::new();
    kept.insert(key, value.clone());
    document.insert("meta", Value::Object(kept));
    document
}

fn fields(include: &[&str], exclude: &[&str], vectors: Option<bool>) -> DocumentProjection {
    let paths = |paths: &[&str]| {
        (!paths.is_empty()).then(|| paths.iter().map(|path| path.to_string()).collect())
    };
    DocumentProjection::Fields {
        include: paths(include),
        exclude: paths(exclude),
        vectors,
    }
}

type Oracle = fn(&Map, Option<bool>) -> Map;

fn by_setting(return_vectors: Option<bool>) -> Kept {
    match return_vectors {
        Some(true) => EVERY_VECTOR,
        _ => NO_VECTOR,
    }
}

fn cases() -> Vec<(&'static str, Option<DocumentProjection>, Oracle)> {
    vec![
        ("absent", None, |source, setting| {
            without_vectors(source, by_setting(setting))
        }),
        ("true", Some(DocumentProjection::All), |source, setting| {
            without_vectors(source, by_setting(setting))
        }),
        ("false", Some(DocumentProjection::None), |_, _| Map::new()),
        (
            "vectors true",
            Some(fields(&[], &[], Some(true))),
            |source, _| without_vectors(source, EVERY_VECTOR),
        ),
        (
            "vectors false",
            Some(fields(&[], &[], Some(false))),
            |source, _| without_vectors(source, NO_VECTOR),
        ),
        (
            "include a vector field by its path",
            Some(fields(&["title", "embedding"], &[], None)),
            |source, _| only(source, &["title", "embedding"]),
        ),
        (
            "vectors false beats an include of the vector field",
            Some(fields(&["title", "embedding"], &[], Some(false))),
            |source, _| only(source, &["title"]),
        ),
        (
            "include the object around a nested vector field",
            Some(fields(&["meta"], &[], None)),
            |source, setting| without_vectors(&only(source, &["meta"]), by_setting(setting)),
        ),
        (
            "include a nested vector field by its path",
            Some(fields(&["meta..embedding."], &[], None)),
            |source, _| meta_only(source, "embedding"),
        ),
        (
            "vectors true with an exclude of one vector field",
            Some(fields(&[], &["embedding"], Some(true))),
            |source, _| {
                let mut document = without_vectors(source, EVERY_VECTOR);
                document.remove("embedding");
                document
            },
        ),
        (
            "vectors true with an include of a text field",
            Some(fields(&["title"], &[], Some(true))),
            |source, _| only(source, &["title"]),
        ),
        (
            "include paths cannot enter vector arrays",
            Some(fields(
                &["title", "embedding.0", "meta.embedding.0"],
                &[],
                Some(true),
            )),
            |source, _| only(source, &["title"]),
        ),
    ]
}

fn loaded(engine: &Narsil, return_vectors: Option<bool>, source: &BTreeMap<String, Map>) {
    engine
        .create_index(INDEX, config(return_vectors))
        .expect("the index is created");
    let batch = engine
        .insert_batch(INDEX, source.values().cloned().collect())
        .expect("the batch is written");
    assert!(batch.failed.is_empty(), "{:?}", batch.failed);
}

fn every_hit(term: bool, projection: &Option<DocumentProjection>) -> QueryParams {
    QueryParams {
        term: term.then(|| "harbour".to_string()),
        vector: (!term).then(|| VectorQuery {
            field: "embedding".to_string(),
            value: Some(vec![0.5; DIMENSIONS]),
            ..VectorQuery::default()
        }),
        limit: Some(DOCUMENT_COUNT),
        document: projection.clone(),
        ..QueryParams::default()
    }
}

fn require_documents(
    label: &str,
    found: BTreeMap<String, Map>,
    expected: &BTreeMap<String, Map>,
    minimum: usize,
) {
    assert!(found.len() >= minimum, "{label}: {} documents", found.len());
    for (id, document) in found {
        assert_eq!(Some(&document), expected.get(&id), "{label}: {id}");
    }
}

fn require_every_read(
    engine: &Narsil,
    index: &str,
    setting: Option<bool>,
    round: &str,
    source: &BTreeMap<String, Map>,
) {
    let ids: Vec<String> = source.keys().cloned().collect();
    for (name, projection, oracle) in cases() {
        let label = format!("{round}, {name}");
        let expected: BTreeMap<String, Map> = source
            .iter()
            .map(|(id, document)| (id.clone(), oracle(document, setting)))
            .collect();
        for id in &ids {
            let found = engine
                .get_with(index, id, projection.as_ref())
                .expect("the read answers");
            assert_eq!(found.as_ref(), expected.get(id), "{label}: get {id}");
        }
        let many = engine
            .get_multiple_with(index, &ids, projection.as_ref())
            .expect("the read answers");
        require_documents(&format!("{label}: get many"), many, &expected, ids.len());
        let listed = engine
            .list_documents(
                index,
                &ListParams {
                    limit: Some(DOCUMENT_COUNT),
                    document: projection.clone(),
                    ..ListParams::default()
                },
            )
            .expect("the listing answers");
        let listed = listed
            .documents
            .into_iter()
            .map(|entry| (entry.id, entry.document))
            .collect();
        require_documents(&format!("{label}: list"), listed, &expected, ids.len());
        for term in [true, false] {
            let result = engine
                .query(index, &every_hit(term, &projection))
                .expect("the search answers");
            let hits = result.hits.into_iter().map(|hit| (hit.id, hit.document));
            require_documents(
                &format!("{label}: search by text {term}"),
                hits.collect(),
                &expected,
                1,
            );
        }
        let grouped = engine
            .query(
                index,
                &QueryParams {
                    group: Some(GroupConfig {
                        fields: vec!["meta.tag".to_string()],
                        max_per_group: Some(DOCUMENT_COUNT),
                        limit: None,
                        reduce: None,
                    }),
                    ..every_hit(true, &projection)
                },
            )
            .expect("the grouped search answers");
        let grouped_hits = grouped
            .groups
            .unwrap_or_default()
            .into_iter()
            .flat_map(|group| group.hits)
            .map(|hit| (hit.id, hit.document));
        require_documents(
            &format!("{label}: groups"),
            grouped_hits.collect(),
            &expected,
            1,
        );
        let reranked = engine
            .query(
                index,
                &QueryParams {
                    rerank: Some(RerankConfig {
                        adapter: RERANKER.to_string(),
                        fields: vec!["title".to_string()],
                        query: None,
                        window: None,
                    }),
                    ..every_hit(true, &projection)
                },
            )
            .expect("the reranked search answers");
        let reranked_hits = reranked.hits.into_iter().map(|hit| (hit.id, hit.document));
        require_documents(
            &format!("{label}: rerank"),
            reranked_hits.collect(),
            &expected,
            1,
        );
    }
}

fn with_reranker(engine: Narsil) -> Narsil {
    let constant = |_: &str, documents: &[String]| -> Result<Vec<f64>, AdapterError> {
        Ok(vec![1.0; documents.len()])
    };
    engine
        .register_rerank_adapter(RERANKER, Arc::new(RerankWith(constant)))
        .expect("the rerank adapter registers");
    engine
}

#[test]
fn every_read_leaves_vectors_out_unless_the_read_or_the_index_asks_for_them() {
    for setting in [None, Some(false), Some(true)] {
        let source = written(true);
        let engine = with_reranker(Narsil::new());
        loaded(&engine, setting, &source);
        require_every_read(&engine, INDEX, setting, &format!("{setting:?}"), &source);
        engine.shutdown().expect("the engine stops");
    }
}

fn updated_to_null_vectors(engine: &Narsil, source: &mut BTreeMap<String, Map>) {
    for id in ["article-00", "article-04"] {
        let Some(document) = source.get_mut(id) else {
            continue;
        };
        document.insert("embedding", Value::Null);
        if let Some(Value::Object(meta)) = document.get_mut("meta") {
            meta.insert("embedding", Value::Null);
        }
        engine
            .update(INDEX, id, document.clone())
            .expect("the update is written");
    }
}

#[test]
fn the_return_vectors_setting_and_null_vector_fields_survive_a_restart_and_a_snapshot_restore() {
    for setting in [None, Some(true)] {
        for tier in [Tier::Log, Tier::Snapshot] {
            let scratch = ScratchDirectory::new("vector-read-projection");
            let root = scratch.path().join("data");
            let round = format!("{setting:?} on {tier:?}");
            let engine = with_reranker(tier.open(&root));
            let mut source = written(true);
            loaded(&engine, setting, &source);
            updated_to_null_vectors(&engine, &mut source);
            require_every_read(
                &engine,
                INDEX,
                setting,
                &format!("{round}, updated"),
                &source,
            );
            if matches!(tier, Tier::Snapshot) {
                engine.checkpoint(INDEX).expect("the checkpoint is written");
            }
            let mut archive = Vec::new();
            engine
                .snapshot(INDEX, &mut archive)
                .expect("the snapshot is written");
            engine.shutdown().expect("the engine stops");

            let reopened = with_reranker(tier.open(&root));
            require_every_read(
                &reopened,
                INDEX,
                setting,
                &format!("{round}, reopened"),
                &source,
            );
            reopened.shutdown().expect("the engine stops");

            let restored = with_reranker(Narsil::new());
            restored
                .create_index(RESTORED, config(None))
                .expect("the target index is created");
            restored
                .restore(RESTORED, &mut archive.as_slice())
                .expect("the snapshot restores");
            require_every_read(
                &restored,
                RESTORED,
                setting,
                &format!("{round}, restored"),
                &source,
            );
            restored.shutdown().expect("the engine stops");
        }
    }
}
