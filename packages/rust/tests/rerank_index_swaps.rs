mod support;

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Weak, mpsc};
use std::time::Duration;

use narsil::{
    AnalysisChange, AnalysisSetting, FacetSpec, IndexConfig, Map, Narsil, PartitionConfig,
    QueryParams, QueryResult, RerankConfig, StopWords, StopWordsSetting, Value, parse_json,
};
use support::adapters::RerankWith;

const INDEX: &str = "trails";
const SEARCHED_WORD: &str = "river";
const SWAPPING: &str = "swapping";
const RERANK_CALLS_THAT_SWAP: usize = 4;
const FEWER_PARTITIONS: usize = 1;
const MORE_PARTITIONS: usize = 2;
const DEADLINE: Duration = Duration::from_secs(10);
const ALTERNATING_STOP_WORDS: [&str; 2] = ["meadow", "canyon"];

const TRAILS: [(&str, &str, &str); 5] = [
    ("shared", "river stone path", "trail"),
    ("restored-crossing", "river crossing", "trail"),
    ("restored-delta", "river delta marsh", "wetland"),
    ("restored-shore", "lake shore", "wetland"),
    ("restored-current", "slow river current water", "wetland"),
];

fn document(title: &str, category: &str) -> Map {
    let mut document = Map::new();
    document.insert("title", Value::String(title.into()));
    document.insert("category", Value::String(category.into()));
    document
}

fn title_length_score(title: &str) -> f64 {
    title.chars().count() as f64
}

fn engine_holding_trails() -> Arc<Narsil> {
    let engine = Arc::new(Narsil::new());
    let config = IndexConfig {
        schema: parse_json(r#"{"title":"string","category":"string"}"#).unwrap(),
        partitions: Some(PartitionConfig {
            max_partitions: Some(MORE_PARTITIONS as u64),
            ..PartitionConfig::default()
        }),
        ..IndexConfig::default()
    };
    engine.create_index(INDEX, config).unwrap();
    for (id, title, category) in TRAILS {
        engine
            .insert(INDEX, document(title, category), Some(id))
            .unwrap();
    }
    engine
}

fn register_swapping(
    engine: &Arc<Narsil>,
    swap: impl Fn(&Narsil, usize) -> narsil::Result<()> + Send + Sync + 'static,
) -> Arc<AtomicUsize> {
    let calls = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&calls);
    let swapping: Weak<Narsil> = Arc::downgrade(engine);
    engine
        .register_rerank_adapter(
            SWAPPING,
            Arc::new(RerankWith(move |_: &str, documents: &[String]| {
                let call = counted.fetch_add(1, Ordering::SeqCst);
                if call < RERANK_CALLS_THAT_SWAP {
                    swap(&swapping.upgrade().unwrap(), call)?;
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

fn reranked_search() -> QueryParams {
    QueryParams {
        term: Some(SEARCHED_WORD.into()),
        facets: Some(vec![("category".into(), FacetSpec::default())]),
        rerank: Some(RerankConfig {
            adapter: SWAPPING.into(),
            fields: vec!["title".into()],
            ..RerankConfig::default()
        }),
        ..QueryParams::default()
    }
}

fn query_within_deadline(engine: &Arc<Narsil>) -> QueryResult {
    let (finished, outcome) = mpsc::channel();
    let querying = Arc::clone(engine);
    std::thread::spawn(move || {
        let _ = finished.send(querying.query(INDEX, &reranked_search()));
    });
    outcome
        .recv_timeout(DEADLINE)
        .expect("the reranked query returns while its rerank calls swap the index")
        .unwrap()
}

fn require_trail_page(result: QueryResult) {
    let mut matching: Vec<&(&str, &str, &str)> = TRAILS
        .iter()
        .filter(|(_, title, _)| title.split_whitespace().any(|word| word == SEARCHED_WORD))
        .collect();
    matching
        .sort_by(|left, right| title_length_score(right.1).total_cmp(&title_length_score(left.1)));
    let ids: Vec<&str> = result.hits.iter().map(|hit| hit.id.as_str()).collect();
    let expected: Vec<&str> = matching.iter().map(|(id, _, _)| *id).collect();
    assert_eq!(ids, expected);
    let documents: Vec<Map> = result.hits.iter().map(|hit| hit.document.clone()).collect();
    let expected_documents: Vec<Map> = matching
        .iter()
        .map(|(_, title, category)| document(title, category))
        .collect();
    assert_eq!(documents, expected_documents);
    assert_eq!(result.count, matching.len() as u64);
    let mut categories = BTreeMap::new();
    for (_, _, category) in &matching {
        *categories.entry((*category).to_string()).or_insert(0) += 1;
    }
    let facets = result.facets.expect("the query asked for category facets");
    let [(field, counted)] = facets.as_slice() else {
        panic!("the query asked for one facet field, and the result holds {facets:?}");
    };
    assert_eq!(field, "category");
    let counted: BTreeMap<String, u64> = counted.values.iter().cloned().collect();
    assert_eq!(counted, categories);
}

fn partition_count(engine: &Narsil) -> usize {
    engine
        .list_indexes()
        .into_iter()
        .find(|info| info.name == INDEX)
        .map(|info| info.partition_count)
        .expect("the index is listed")
}

#[test]
fn a_reranked_query_returns_its_page_when_a_rebalance_swaps_the_index_during_each_of_four_rerank_calls()
 {
    let engine = engine_holding_trails();
    let calls = register_swapping(&engine, |engine, _| {
        let wanted = match partition_count(engine) {
            MORE_PARTITIONS => FEWER_PARTITIONS,
            _ => MORE_PARTITIONS,
        };
        engine.rebalance(INDEX, wanted)?;
        assert_eq!(partition_count(engine), wanted);
        Ok(())
    });

    for _ in 0..RERANK_CALLS_THAT_SWAP {
        require_trail_page(query_within_deadline(&engine));
    }

    assert_eq!(calls.load(Ordering::SeqCst), RERANK_CALLS_THAT_SWAP);
}

#[test]
fn a_reranked_query_returns_its_page_when_an_analysis_change_swaps_the_index_during_each_of_four_rerank_calls()
 {
    let engine = engine_holding_trails();
    let calls = register_swapping(&engine, |engine, call| {
        let word = ALTERNATING_STOP_WORDS[call % ALTERNATING_STOP_WORDS.len()];
        let change = AnalysisChange {
            stop_words: AnalysisSetting::Set(StopWordsSetting::Words(StopWords::Set(
                [word.to_string()].into_iter().collect(),
            ))),
            ..AnalysisChange::default()
        };
        engine.change_analysis(INDEX, &change)
    });

    for _ in 0..RERANK_CALLS_THAT_SWAP {
        require_trail_page(query_within_deadline(&engine));
    }

    assert_eq!(calls.load(Ordering::SeqCst), RERANK_CALLS_THAT_SWAP);
}
