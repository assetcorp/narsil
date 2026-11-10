mod support;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use narsil::{
    AdapterError, Bm25FieldParams, Bm25Params, DurabilityConfig, DurabilityMode, DurabilityTier,
    ErrorCode, IndexConfig, Map, MemoryPersistence, Narsil, NarsilConfig, PartitionConfig,
    PersistenceAdapter, QueryParams, Value,
};
use support::ScratchDirectory;

const INDEX: &str = "fruit";
const SHORT: &str = "short";
const LONG: &str = "long";

struct FlakyPersistence {
    stored: MemoryPersistence,
    refusing: AtomicBool,
}

impl PersistenceAdapter for FlakyPersistence {
    fn save(&self, key: &str, data: &[u8]) -> Result<(), AdapterError> {
        if self.refusing.load(Ordering::SeqCst) {
            return Err("the disk refused the write".into());
        }
        self.stored.save(key, data)
    }

    fn load(&self, key: &str) -> Result<Option<Vec<u8>>, AdapterError> {
        self.stored.load(key)
    }

    fn delete(&self, key: &str) -> Result<(), AdapterError> {
        self.stored.delete(key)
    }

    fn list(&self, prefix: &str) -> Result<Vec<String>, AdapterError> {
        self.stored.list(prefix)
    }
}

fn flaky() -> Arc<FlakyPersistence> {
    Arc::new(FlakyPersistence {
        stored: MemoryPersistence::new(),
        refusing: AtomicBool::new(false),
    })
}

fn wal_config(root: &ScratchDirectory) -> NarsilConfig {
    NarsilConfig {
        durability: Some(DurabilityConfig {
            directory: Some(root.path().to_path_buf()),
            mode: Some(DurabilityMode::Sync),
            ..DurabilityConfig::default()
        }),
        ..NarsilConfig::default()
    }
}

fn snapshot_config(adapter: Arc<FlakyPersistence>) -> NarsilConfig {
    NarsilConfig {
        durability: Some(DurabilityConfig {
            tier: Some(DurabilityTier::Snapshot),
            ..DurabilityConfig::default()
        }),
        persistence: Some(adapter),
        ..NarsilConfig::default()
    }
}

fn index_config(partitions: Option<PartitionConfig>) -> IndexConfig {
    let mut schema = Map::new();
    schema.insert("title", Value::String("string".into()));
    IndexConfig {
        schema: Value::Object(schema),
        partitions,
        ..IndexConfig::default()
    }
}

fn titled(title: &str) -> Map {
    let mut document = Map::new();
    document.insert("title", Value::String(title.into()));
    document
}

fn seed_fruit(narsil: &Narsil) {
    narsil
        .create_index(INDEX, index_config(None))
        .expect("the index is created");
    narsil
        .insert(INDEX, titled("apple"), Some(SHORT))
        .expect("the short document is written");
    narsil
        .insert(
            INDEX,
            titled("apple banana cherry damson elderberry fig grape"),
            Some(LONG),
        )
        .expect("the long document is written");
}

fn apple_scores(narsil: &Narsil) -> (f64, f64) {
    let query = QueryParams {
        term: Some("apple".into()),
        ..QueryParams::default()
    };
    let result = narsil.query(INDEX, &query).expect("the search answers");
    let score_of = |id: &str| {
        result
            .hits
            .iter()
            .find(|hit| hit.id == id)
            .and_then(|hit| hit.score)
            .unwrap_or_else(|| {
                panic!(
                    "{id} is missing from the hits {:?}, count {:?}",
                    result.hits.iter().map(|hit| &hit.id).collect::<Vec<_>>(),
                    narsil.count_documents(INDEX)
                )
            })
    };
    (score_of(SHORT), score_of(LONG))
}

fn ignores_length(narsil: &Narsil) -> bool {
    let (short, long) = apple_scores(narsil);
    (short - long).abs() < 1e-9
}

fn no_length_normalisation() -> Bm25Params {
    Bm25Params {
        b: Some(0.0),
        ..Bm25Params::default()
    }
}

fn require_refused(outcome: narsil::Result<()>, code: ErrorCode, what: &str) {
    match outcome {
        Err(error) => assert_eq!(error.code(), code, "{what}: {}", error.message()),
        Ok(()) => panic!("{what} was accepted"),
    }
}

fn require_bm25_rules(narsil: &Narsil) {
    let bad = [
        (
            Bm25Params {
                b: Some(1.5),
                ..Bm25Params::default()
            },
            "b above 1",
        ),
        (
            Bm25Params {
                k1: Some(-1.0),
                ..Bm25Params::default()
            },
            "a negative k1",
        ),
        (
            Bm25Params {
                b: Some(f64::NAN),
                ..Bm25Params::default()
            },
            "a NaN b",
        ),
        (
            Bm25Params {
                fields: Some(vec![(
                    "missing".into(),
                    Bm25FieldParams {
                        k1: None,
                        b: Some(0.0),
                    },
                )]),
                ..Bm25Params::default()
            },
            "a field outside the schema",
        ),
    ];
    for (params, what) in bad {
        assert!(
            narsil.update_bm25(INDEX, &params).is_err(),
            "{what} was accepted"
        );
        assert!(!ignores_length(narsil), "{what} changed the scores");
    }
    require_refused(
        narsil.update_bm25("absent", &no_length_normalisation()),
        ErrorCode::INDEX_NOT_FOUND,
        "a change of an absent index",
    );
}

#[test]
fn a_bm25_change_holds_after_a_restart_under_the_write_ahead_log() {
    let root = ScratchDirectory::new("bm25-wal");
    let narsil = Narsil::open(wal_config(&root)).expect("the engine opens");
    seed_fruit(&narsil);
    let (short, long) = apple_scores(&narsil);
    assert!(
        short > long,
        "the shorter title ranks first under the default b"
    );
    require_bm25_rules(&narsil);
    narsil
        .update_bm25(INDEX, &no_length_normalisation())
        .expect("the change is accepted");
    assert!(ignores_length(&narsil), "b of 0 ignores the title length");
    narsil.shutdown().expect("the engine shuts down");
    let reopened = Narsil::open(wal_config(&root)).expect("the engine reopens");
    assert!(ignores_length(&reopened), "b of 0 holds after the restart");
}

#[test]
fn a_bm25_change_holds_after_a_restart_under_snapshots() {
    let adapter = flaky();
    let narsil = Narsil::open(snapshot_config(Arc::clone(&adapter))).expect("the engine opens");
    seed_fruit(&narsil);
    narsil
        .update_bm25(INDEX, &no_length_normalisation())
        .expect("the change is accepted");
    narsil.checkpoint(INDEX).expect("the checkpoint is written");
    narsil.shutdown().expect("the engine shuts down");
    let reopened = Narsil::open(snapshot_config(adapter)).expect("the engine reopens");
    assert!(ignores_length(&reopened), "b of 0 holds after the restart");
}

#[test]
fn a_settings_change_that_fails_to_persist_keeps_the_old_settings_serving() {
    let adapter = flaky();
    let narsil = Narsil::open(snapshot_config(Arc::clone(&adapter))).expect("the engine opens");
    seed_fruit(&narsil);
    narsil
        .update_partition_config(
            INDEX,
            &PartitionConfig {
                max_docs_per_partition: Some(10),
                ..PartitionConfig::default()
            },
        )
        .expect("the first limit is accepted");
    adapter.refusing.store(true, Ordering::SeqCst);
    assert!(
        narsil
            .update_bm25(INDEX, &no_length_normalisation())
            .is_err(),
        "a change that no store holds is refused"
    );
    assert!(!ignores_length(&narsil), "the old b still serves");
    assert!(
        narsil
            .update_partition_config(
                INDEX,
                &PartitionConfig {
                    max_docs_per_partition: Some(2),
                    ..PartitionConfig::default()
                },
            )
            .is_err(),
        "a limit that no store holds is refused"
    );
    adapter.refusing.store(false, Ordering::SeqCst);
    narsil
        .insert(INDEX, titled("apple pie"), Some("third"))
        .expect("the old limit of 10 still admits a third document");
    narsil.checkpoint(INDEX).expect("the checkpoint is written");
    narsil.shutdown().expect("the engine shuts down");
    let reopened = Narsil::open(snapshot_config(adapter)).expect("the engine reopens");
    assert!(
        !ignores_length(&reopened),
        "the refused b never reached the store"
    );
    assert_eq!(reopened.count_documents(INDEX).expect("the count reads"), 3);
}

#[test]
fn partition_limits_refuse_bad_values_and_hold_after_a_restart() {
    let root = ScratchDirectory::new("partition-limits");
    let narsil = Narsil::open(wal_config(&root)).expect("the engine opens");
    narsil
        .create_index(
            INDEX,
            index_config(Some(PartitionConfig {
                max_partitions: Some(2),
                ..PartitionConfig::default()
            })),
        )
        .expect("the index is created");
    for at in 0..5 {
        narsil
            .insert(INDEX, titled("apple"), Some(&format!("doc-{at}")))
            .expect("the document is written");
    }
    let limit = |change: PartitionConfig| narsil.update_partition_config(INDEX, &change);
    require_refused(
        limit(PartitionConfig {
            max_partitions: Some(1),
            ..PartitionConfig::default()
        }),
        ErrorCode::PARTITION_CAPACITY_EXCEEDED,
        "maxPartitions below the two partitions",
    );
    require_refused(
        limit(PartitionConfig {
            max_docs_per_partition: Some(2),
            ..PartitionConfig::default()
        }),
        ErrorCode::PARTITION_CAPACITY_EXCEEDED,
        "a capacity of 4 under 5 documents",
    );
    for (bad, what) in [
        (
            PartitionConfig {
                watermark: Some(1.5),
                ..PartitionConfig::default()
            },
            "a watermark above 1",
        ),
        (
            PartitionConfig {
                max_docs_per_partition: Some(0),
                ..PartitionConfig::default()
            },
            "a capacity of 0",
        ),
    ] {
        assert!(limit(bad).is_err(), "{what} was accepted");
    }
    limit(PartitionConfig {
        max_docs_per_partition: Some(3),
        ..PartitionConfig::default()
    })
    .expect("a capacity of 6 is accepted");
    narsil
        .insert(INDEX, titled("apple"), Some("doc-5"))
        .expect("the sixth document fits");
    narsil.shutdown().expect("the engine shuts down");
    let reopened = Narsil::open(wal_config(&root)).expect("the engine reopens");
    match reopened.insert(INDEX, titled("apple"), Some("doc-6")) {
        Err(error) => assert_eq!(error.code(), ErrorCode::PARTITION_CAPACITY_EXCEEDED),
        Ok(_) => panic!("the seventh document passed a capacity of 6 after the restart"),
    }
    assert_eq!(reopened.count_documents(INDEX).expect("the count reads"), 6);
}
