use std::time::{Duration, Instant};

use narsil::{ErrorCode, IndexConfig, Map, Narsil, NarsilConfig, QueryParams, Value, parse_json};

const INDEX: &str = "invoices";
const INVOICE_TITLE: &str = "invoice";
const UNCAPPED_PATTERN_WORK: u64 = 9_007_199_254_740_991;
const COSTLY_DOCUMENTS: usize = 400;
const COSTLY_VALUE_CODE_POINTS: usize = 2_000;
const INSERT_BATCH_DOCUMENTS: usize = 500;
const COSTLY_REGEX: &str = r#"{"fields": {"code": {"regex": "[ab]{2000}$"}}}"#;
const SHORTEST_UNINTERRUPTED_SEARCH: Duration = Duration::from_secs(1);
const SHARE_OF_SEARCH_BEFORE_SHUTDOWN: u32 = 10;
const SHARE_OF_SEARCH_AFTER_SHUTDOWN: u32 = 4;

fn index_config() -> IndexConfig {
    let mut schema = Map::new();
    schema.insert("code", Value::String("verbatim".into()));
    schema.insert("title", Value::String("string".into()));
    IndexConfig {
        schema: Value::Object(schema),
        ..IndexConfig::default()
    }
}

fn costly_value(number: usize) -> String {
    (0..COSTLY_VALUE_CODE_POINTS)
        .map(|at| {
            if (at * 7 + number).is_multiple_of(3) {
                'b'
            } else {
                'a'
            }
        })
        .collect()
}

fn engine_with_costly_values() -> Narsil {
    let engine = Narsil::open(NarsilConfig {
        pattern_work_cap: Some(UNCAPPED_PATTERN_WORK),
        ..NarsilConfig::default()
    })
    .expect("the engine opens");
    engine
        .create_index(INDEX, index_config())
        .expect("the index is created");
    let numbers: Vec<usize> = (0..COSTLY_DOCUMENTS).collect();
    for batch in numbers.chunks(INSERT_BATCH_DOCUMENTS) {
        let documents = batch
            .iter()
            .map(|&number| {
                let mut document = Map::new();
                document.insert("code", Value::String(costly_value(number)));
                document.insert("title", Value::String(INVOICE_TITLE.into()));
                document
            })
            .collect();
        engine
            .insert_batch(INDEX, documents)
            .expect("the batch is inserted");
    }
    engine
}

fn costly_search() -> QueryParams {
    QueryParams {
        term: Some(INVOICE_TITLE.into()),
        filters: Some(parse_json(COSTLY_REGEX).expect("the filter is JSON")),
        ..QueryParams::default()
    }
}

#[test]
fn shutdown_stops_a_pattern_search_in_flight_with_the_shut_down_error() {
    let engine = engine_with_costly_values();
    let started = Instant::now();
    let uninterrupted = engine
        .query(INDEX, &costly_search())
        .expect("the costly search finishes");
    let alone = started.elapsed();
    assert_eq!(
        uninterrupted.count, COSTLY_DOCUMENTS as u64,
        "every value holds 2,000 letters a and b"
    );
    assert!(
        alone >= SHORTEST_UNINTERRUPTED_SEARCH,
        "the costly search took {alone:?}, too little time to stop it part of the way through"
    );
    let (outcome, shutdown_took, stopped_after) = std::thread::scope(|scope| {
        let search = scope.spawn(|| {
            let outcome = engine.query(INDEX, &costly_search());
            (outcome, Instant::now())
        });
        std::thread::sleep(alone / SHARE_OF_SEARCH_BEFORE_SHUTDOWN);
        let shutdown_began = Instant::now();
        engine.shutdown().expect("the engine shuts down");
        let shutdown_took = shutdown_began.elapsed();
        let (outcome, returned) = search.join().expect("the search thread finishes");
        (
            outcome,
            shutdown_took,
            returned.saturating_duration_since(shutdown_began),
        )
    });
    let error = match outcome {
        Ok(result) => panic!(
            "the search ran to the end after shutdown and returned {} hits",
            result.hits.len()
        ),
        Err(error) => error,
    };
    assert_eq!(error.code(), ErrorCode::INSTANCE_SHUT_DOWN);
    let bound = alone / SHARE_OF_SEARCH_AFTER_SHUTDOWN;
    assert!(
        shutdown_took < bound,
        "shutdown took {shutdown_took:?}, while the bound is {bound:?}"
    );
    assert!(
        stopped_after < bound,
        "the search ran {stopped_after:?} past shutdown, while the bound is {bound:?}, a quarter of the {alone:?} that it takes alone"
    );
    let after = engine
        .query(INDEX, &costly_search())
        .expect_err("a search after shutdown fails");
    assert_eq!(after.code(), error.code());
    assert_eq!(after.message(), error.message());
}
