mod support;

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Weak};

use narsil::{FacetSpec, IndexConfig, Map, Narsil, QueryParams, RerankConfig, Value, parse_json};
use support::adapters::RerankWith;
use support::portable::snapshot_of;

const INDEX: &str = "trails";
const SEARCHED_WORD: &str = "river";
const RERANK_CALLS_WITH_ONE_RESTORE: usize = 2;

const REPLACED_DOCUMENTS: [(&str, &str, &str); 4] = [
    ("shared", "river stone", "old"),
    ("replaced-bend", "river bend", "old"),
    ("replaced-mouth", "river mouth wide", "old"),
    ("replaced-quiet", "quiet river", "old"),
];

const RESTORED_DOCUMENTS: [(&str, &str, &str); 5] = [
    ("shared", "river stone path", "trail"),
    ("restored-crossing", "river crossing", "trail"),
    ("restored-delta", "river delta marsh", "wetland"),
    ("restored-shore", "lake shore", "wetland"),
    ("restored-current", "slow river current water", "wetland"),
];

fn config() -> IndexConfig {
    IndexConfig {
        schema: parse_json(r#"{"title":"string","category":"string"}"#).unwrap(),
        ..IndexConfig::default()
    }
}

fn document(title: &str, category: &str) -> Map {
    let mut document = Map::new();
    document.insert("title", Value::String(title.into()));
    document.insert("category", Value::String(category.into()));
    document
}

fn engine_holding(documents: &[(&str, &str, &str)]) -> Narsil {
    let engine = Narsil::new();
    engine.create_index(INDEX, config()).unwrap();
    for (id, title, category) in documents {
        engine
            .insert(INDEX, document(title, category), Some(id))
            .unwrap();
    }
    engine
}

fn title_length_score(title: &str) -> f64 {
    title.chars().count() as f64
}

struct ExpectedPage {
    ids: Vec<String>,
    documents: Vec<Map>,
    count: u64,
    categories: BTreeMap<String, u64>,
}

fn expected_page(documents: &[(&str, &str, &str)]) -> ExpectedPage {
    let mut matching: Vec<&(&str, &str, &str)> = documents
        .iter()
        .filter(|(_, title, _)| title.split_whitespace().any(|word| word == SEARCHED_WORD))
        .collect();
    matching
        .sort_by(|left, right| title_length_score(right.1).total_cmp(&title_length_score(left.1)));
    let mut categories = BTreeMap::new();
    for (_, _, category) in &matching {
        *categories.entry((*category).to_string()).or_insert(0) += 1;
    }
    ExpectedPage {
        ids: matching
            .iter()
            .map(|(id, _, _)| (*id).to_string())
            .collect(),
        documents: matching
            .iter()
            .map(|(_, title, category)| document(title, category))
            .collect(),
        count: matching.len() as u64,
        categories,
    }
}

fn register_restoring_once(engine: &Arc<Narsil>, archive: Vec<u8>) -> Arc<AtomicUsize> {
    let calls = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&calls);
    let restoring: Weak<Narsil> = Arc::downgrade(engine);
    engine
        .register_rerank_adapter(
            "restoring",
            Arc::new(RerankWith(move |_: &str, documents: &[String]| {
                if counted.fetch_add(1, Ordering::SeqCst) == 0 {
                    restoring
                        .upgrade()
                        .unwrap()
                        .restore(INDEX, &mut archive.as_slice())?;
                }
                Ok(documents
                    .iter()
                    .map(|text| title_length_score(text))
                    .collect())
            })),
        )
        .unwrap();
    calls
}

#[test]
fn a_reranked_query_whose_index_one_restore_replaces_returns_a_page_of_the_restored_index() {
    let source = engine_holding(&RESTORED_DOCUMENTS);
    let archive = snapshot_of(&source, INDEX);
    let target = Arc::new(engine_holding(&REPLACED_DOCUMENTS));
    let calls = register_restoring_once(&target, archive);

    let result = target
        .query(
            INDEX,
            &QueryParams {
                term: Some(SEARCHED_WORD.into()),
                facets: Some(vec![("category".into(), FacetSpec::default())]),
                rerank: Some(RerankConfig {
                    adapter: "restoring".into(),
                    fields: vec!["title".into()],
                    ..RerankConfig::default()
                }),
                ..QueryParams::default()
            },
        )
        .unwrap();

    let expected = expected_page(&RESTORED_DOCUMENTS);
    let ids: Vec<String> = result.hits.iter().map(|hit| hit.id.clone()).collect();
    assert_eq!(ids, expected.ids);
    let documents: Vec<Map> = result.hits.iter().map(|hit| hit.document.clone()).collect();
    assert_eq!(documents, expected.documents);
    assert_eq!(result.count, expected.count);
    let facets = result.facets.expect("the query asked for category facets");
    let [(field, categories)] = facets.as_slice() else {
        panic!("the query asked for one facet field, and the result holds {facets:?}");
    };
    assert_eq!(field, "category");
    let counted: BTreeMap<String, u64> = categories.values.iter().cloned().collect();
    assert_eq!(counted, expected.categories);
    assert_eq!(calls.load(Ordering::SeqCst), RERANK_CALLS_WITH_ONE_RESTORE);
}
