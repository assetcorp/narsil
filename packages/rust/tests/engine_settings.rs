mod support;

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use narsil::{
    ErrorCode, IdGenerator, IndexConfig, IndexLifecycleConfig, Map, MemoryConfig, Narsil,
    NarsilConfig, QueryParams, RerankConfig, Value,
};
use support::adapters::RerankWith;

const INDEX: &str = "notes";
const SLOW_ADAPTER_SLEEP: Duration = Duration::from_secs(3);

fn index_config() -> IndexConfig {
    let mut schema = Map::new();
    schema.insert("title", Value::String("string".into()));
    IndexConfig {
        schema: Value::Object(schema),
        ..IndexConfig::default()
    }
}

fn note(title: &str) -> Map {
    let mut document = Map::new();
    document.insert("title", Value::String(title.to_string()));
    document
}

fn refusal(config: NarsilConfig) -> (ErrorCode, String) {
    let error = match Narsil::open(config) {
        Ok(_) => panic!("the engine opened with a bad setting"),
        Err(error) => error,
    };
    (error.code(), error.message().to_string())
}

#[test]
fn every_out_of_range_engine_setting_is_refused_before_the_engine_opens() {
    let lifecycle = |config: IndexLifecycleConfig| NarsilConfig {
        lifecycle: Some(config),
        ..NarsilConfig::default()
    };
    let memory = |block: Option<f64>, resume: Option<f64>| NarsilConfig {
        memory: Some(MemoryConfig {
            block_writes_above: block,
            resume_writes_below: resume,
        }),
        ..NarsilConfig::default()
    };
    let cases = [
        (
            lifecycle(IndexLifecycleConfig {
                idle_timeout_ms: Some(0),
                ..IndexLifecycleConfig::default()
            }),
            "lifecycle.idleTimeoutMs must be a positive safe integer",
        ),
        (
            lifecycle(IndexLifecycleConfig {
                max_open_indexes: Some(0),
                ..IndexLifecycleConfig::default()
            }),
            "lifecycle.maxOpenIndexes must be a positive safe integer",
        ),
        (
            lifecycle(IndexLifecycleConfig {
                max_open_bytes: Some(9_007_199_254_740_992),
                ..IndexLifecycleConfig::default()
            }),
            "lifecycle.maxOpenBytes must be a positive safe integer",
        ),
        (
            lifecycle(IndexLifecycleConfig {
                max_reopen_waiters: Some(u64::MAX),
                ..IndexLifecycleConfig::default()
            }),
            "lifecycle.maxReopenWaiters must be a non-negative safe integer",
        ),
        (
            memory(Some(0.0), None),
            "memory.blockWritesAbove must be a number above 0 and at most 1",
        ),
        (
            memory(Some(f64::NAN), None),
            "memory.blockWritesAbove must be a number above 0 and at most 1",
        ),
        (
            memory(None, Some(1.5)),
            "memory.resumeWritesBelow must be a number above 0 and at most 1",
        ),
        (
            memory(Some(0.5), Some(0.5)),
            "memory.resumeWritesBelow (0.5) must lie below blockWritesAbove (0.5)",
        ),
        (
            memory(Some(0.7), None),
            "memory.resumeWritesBelow (0.8) must lie below blockWritesAbove (0.7)",
        ),
        (
            NarsilConfig {
                rerank_timeout_ms: Some(0),
                ..NarsilConfig::default()
            },
            "rerankTimeout must be a whole number of milliseconds from 1 to 2147483647",
        ),
        (
            NarsilConfig {
                rerank_timeout_ms: Some(2_147_483_648),
                ..NarsilConfig::default()
            },
            "rerankTimeout must be a whole number of milliseconds from 1 to 2147483647",
        ),
        (
            NarsilConfig {
                max_rerank_window: Some(1_001),
                ..NarsilConfig::default()
            },
            "maxRerankWindow must be a whole number from 1 to 1000",
        ),
    ];
    for (config, wanted) in cases {
        assert_eq!(
            refusal(config),
            (ErrorCode::CONFIG_INVALID, wanted.to_string())
        );
    }
    let edges = NarsilConfig {
        memory: Some(MemoryConfig {
            block_writes_above: Some(1.0),
            resume_writes_below: Some(0.99),
        }),
        rerank_timeout_ms: Some(2_147_483_647),
        max_rerank_window: Some(1_000),
        lifecycle: Some(IndexLifecycleConfig {
            max_reopen_waiters: Some(0),
            ..IndexLifecycleConfig::default()
        }),
        ..NarsilConfig::default()
    };
    let engine = Narsil::open(edges).expect("the edge values open");
    engine.create_index(INDEX, index_config()).expect("created");
    engine
        .insert(INDEX, note("boiler"), None)
        .expect("a write passes a block at 1");
}

fn is_uuid_version_seven(id: &str) -> bool {
    let groups: Vec<&str> = id.split('-').collect();
    let lengths: Vec<usize> = groups.iter().map(|group| group.len()).collect();
    lengths == [8, 4, 4, 4, 12]
        && id
            .chars()
            .all(|c| c == '-' || c.is_ascii_digit() || ('a'..='f').contains(&c))
        && groups[2].starts_with('7')
        && groups[3].starts_with(['8', '9', 'a', 'b'])
}

#[test]
fn inserts_without_an_id_take_the_generator_id_and_survive_a_panicking_generator() {
    let plain = Narsil::new();
    plain.create_index(INDEX, index_config()).expect("created");
    let id = plain.insert(INDEX, note("gutter"), None).expect("inserted");
    assert!(is_uuid_version_seven(&id), "{id} is no UUID version 7");

    let next = Arc::new(AtomicU64::new(0));
    let counter = Arc::clone(&next);
    let generator: IdGenerator = Arc::new(move || {
        let n = counter.fetch_add(1, Ordering::SeqCst);
        if n == 3 {
            panic!("the generator ran out of numbers");
        }
        format!("note-{n}")
    });
    let engine = Narsil::open(NarsilConfig {
        id_generator: Some(generator),
        ..NarsilConfig::default()
    })
    .expect("the engine opens");
    engine.create_index(INDEX, index_config()).expect("created");
    assert_eq!(
        engine
            .insert(INDEX, note("boiler"), None)
            .expect("inserted"),
        "note-0"
    );
    assert_eq!(
        engine
            .insert(INDEX, note("given"), Some("kept"))
            .expect("inserted"),
        "kept"
    );
    let batch = engine
        .insert_batch(
            INDEX,
            vec![
                note("window"),
                note("carpet"),
                note("attic"),
                note("ladder"),
            ],
        )
        .expect("the batch answers");
    assert_eq!(batch.succeeded, vec!["note-1", "note-2", "note-4"]);
    assert_eq!(batch.failed.len(), 1);
    assert_eq!(batch.failed[0].error.code(), ErrorCode::INTERNAL_ERROR);
    assert_eq!(engine.count_documents(INDEX).expect("counted"), 5);
    for (id, title) in [
        ("note-0", "boiler"),
        ("kept", "given"),
        ("note-4", "ladder"),
    ] {
        assert_eq!(engine.get(INDEX, id).expect("read"), Some(note(title)));
    }
}

fn reranked(window: Option<usize>, adapter: &str) -> QueryParams {
    QueryParams {
        term: Some("boiler".into()),
        rerank: Some(RerankConfig {
            adapter: adapter.to_string(),
            fields: vec!["title".into()],
            window,
            ..RerankConfig::default()
        }),
        ..QueryParams::default()
    }
}

#[test]
fn the_rerank_window_and_timeout_settings_bound_every_reranked_query() {
    let engine = Narsil::open(NarsilConfig {
        rerank_timeout_ms: Some(200),
        max_rerank_window: Some(3),
        ..NarsilConfig::default()
    })
    .expect("the engine opens");
    engine.create_index(INDEX, index_config()).expect("created");
    for n in 0..6 {
        engine
            .insert(INDEX, note(&format!("boiler {n}")), None)
            .expect("inserted");
    }
    let seen = Arc::new(AtomicU64::new(0));
    let counted = Arc::clone(&seen);
    engine
        .register_rerank_adapter(
            "counting",
            Arc::new(RerankWith(move |_: &str, documents: &[String]| {
                counted.store(documents.len() as u64, Ordering::SeqCst);
                Ok(vec![1.0; documents.len()])
            })),
        )
        .expect("registered");
    engine
        .register_rerank_adapter(
            "slow",
            Arc::new(RerankWith(|_: &str, documents: &[String]| {
                std::thread::sleep(SLOW_ADAPTER_SLEEP);
                Ok(vec![0.0; documents.len()])
            })),
        )
        .expect("registered");
    let too_wide = engine
        .query(INDEX, &reranked(Some(4), "counting"))
        .expect_err("a window past the engine's limit is refused");
    assert_eq!(too_wide.code(), ErrorCode::RERANK_CONFIG_INVALID);
    assert_eq!(
        too_wide.message(),
        "rerank.window must be a whole number from 1 to 3"
    );
    engine
        .query(INDEX, &reranked(None, "counting"))
        .expect("the default window answers");
    assert_eq!(
        seen.load(Ordering::SeqCst),
        3,
        "the default window follows the limit"
    );
    let started = Instant::now();
    let timed_out = engine
        .query(INDEX, &reranked(None, "slow"))
        .expect_err("the engine gives up on a slow adapter");
    assert!(
        started.elapsed() < SLOW_ADAPTER_SLEEP,
        "the timeout did not apply"
    );
    assert_eq!(timed_out.code(), ErrorCode::RERANK_FAILED);
    assert_eq!(
        timed_out.message(),
        "Rerank adapter \"slow\" did not answer within 200 ms, so the engine cancelled the call"
    );
}

#[cfg(any(target_os = "linux", target_os = "macos", windows))]
#[test]
fn a_full_engine_refuses_inserts_and_updates_and_keeps_removes_and_searches() {
    let engine = Narsil::open(NarsilConfig {
        memory: Some(MemoryConfig {
            block_writes_above: Some(1e-12),
            resume_writes_below: Some(1e-13),
        }),
        ..NarsilConfig::default()
    })
    .expect("the engine opens");
    engine.create_index(INDEX, index_config()).expect("created");
    let blocked = |outcome: narsil::Result<()>| {
        let error = outcome.expect_err("a full engine refuses the write");
        assert_eq!(error.code(), ErrorCode::MEMORY_WRITE_BLOCKED);
        assert!(
            error.message().starts_with(&format!(
                "The engine refuses inserts and updates to index '{INDEX}' because its memory passed the block level of its limit ("
            )),
            "{}",
            error.message()
        );
    };
    blocked(engine.insert(INDEX, note("boiler"), Some("a")).map(|_| ()));
    blocked(engine.insert_batch(INDEX, vec![note("boiler")]).map(|_| ()));
    blocked(engine.update(INDEX, "a", note("boiler")));
    blocked(
        engine
            .update_batch(INDEX, vec![("a".into(), note("boiler"))])
            .map(|_| ()),
    );
    let missing = engine
        .insert("missing", note("boiler"), None)
        .expect_err("a missing index wins over the block");
    assert_eq!(missing.code(), ErrorCode::INDEX_NOT_FOUND);
    assert_eq!(engine.count_documents(INDEX).expect("counted"), 0);
    let removed = engine.remove(INDEX, "a").expect_err("nothing to remove");
    assert_eq!(removed.code(), ErrorCode::DOC_NOT_FOUND);
    let found = engine
        .query(
            INDEX,
            &QueryParams {
                term: Some("boiler".into()),
                ..QueryParams::default()
            },
        )
        .expect("a full engine still searches");
    assert_eq!(found.count, 0);
    engine
        .drop_index(INDEX)
        .expect("a full engine still drops an index");
    engine.shutdown().expect("the engine stops");
    let stopped = engine
        .insert(INDEX, note("boiler"), None)
        .expect_err("a stopped engine refuses");
    assert_eq!(stopped.code(), ErrorCode::INSTANCE_SHUT_DOWN);
}
