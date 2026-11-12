mod support;

use std::collections::BTreeMap;
use std::path::Path;

use narsil::{
    DurabilityConfig, ErrorCode, IndexConfig, Map, Narsil, NarsilConfig, PartitionConfig,
    QueryParams, Value,
};
use support::{ScratchDirectory, rewrite_saved_file as rewrite};

const INDEX: &str = "catalogue";
const SAVED_PARTITIONS: u64 = 4;
const DOCUMENTS: u64 = 400;
const WORDS: [&str; 4] = ["anchor", "beacon", "compass", "harbour"];
const PARTITION_LIMIT: u64 = 65_536;
const STORED_PAST_THE_LIMIT: u64 = 70_000;
const SMALLER_LIMIT: u64 = 2;

fn durable(root: &Path) -> NarsilConfig {
    NarsilConfig {
        durability: Some(DurabilityConfig {
            directory: Some(root.to_path_buf()),
            ..DurabilityConfig::default()
        }),
        ..NarsilConfig::default()
    }
}

fn partitioned(max_partitions: u64) -> IndexConfig {
    let mut schema = Map::new();
    schema.insert("title", Value::String("string".into()));
    IndexConfig {
        schema: Value::Object(schema),
        partitions: Some(PartitionConfig {
            max_partitions: Some(max_partitions),
            ..PartitionConfig::default()
        }),
        ..IndexConfig::default()
    }
}

fn title_of(number: u64) -> String {
    format!(
        "{} item {number}",
        WORDS[(number % WORDS.len() as u64) as usize]
    )
}

fn saved_index(root: &Path) -> BTreeMap<String, String> {
    let engine = Narsil::open(durable(root)).expect("the engine opens");
    engine
        .create_index(INDEX, partitioned(SAVED_PARTITIONS))
        .expect("the index is created");
    let mut model = BTreeMap::new();
    let mut documents = Vec::new();
    for number in 0..DOCUMENTS {
        let id = format!("item-{number}");
        let mut document = Map::new();
        document.insert("id", Value::String(id.clone()));
        document.insert("title", Value::String(title_of(number)));
        documents.push(document);
        model.insert(id, title_of(number));
    }
    let stored = engine
        .insert_batch(INDEX, documents)
        .expect("the documents are stored");
    assert!(stored.failed.is_empty(), "every document is stored");
    engine.checkpoint(INDEX).expect("the checkpoint is written");
    assert_eq!(
        engine
            .get_stats(INDEX)
            .expect("the stats read")
            .partition_count,
        SAVED_PARTITIONS as usize
    );
    engine.shutdown().expect("the engine shuts down");
    model
}

fn rewrite_stored_max_partitions(root: &Path, count: u64) {
    let meta = root.join(INDEX).join("meta");
    rewrite(
        &meta,
        &[
            "max-partitions",
            meta.to_str().expect("a UTF-8 path"),
            &count.to_string(),
        ],
    );
}

fn require_every_document(engine: &Narsil, model: &BTreeMap<String, String>, when: &str) {
    for word in WORDS {
        let found = engine
            .query(
                INDEX,
                &QueryParams {
                    term: Some(word.to_string()),
                    limit: Some(DOCUMENTS as usize),
                    ..QueryParams::default()
                },
            )
            .expect("the search succeeds");
        let mut ids: Vec<String> = found.hits.into_iter().map(|hit| hit.id).collect();
        ids.sort();
        let wanted: Vec<String> = model
            .iter()
            .filter(|(_, title)| title.starts_with(word))
            .map(|(id, _)| id.clone())
            .collect();
        assert_eq!(ids, wanted, "{when}: the documents that hold \"{word}\"");
    }
}

fn rebalance_code(engine: &Narsil, target: usize) -> ErrorCode {
    engine
        .rebalance(INDEX, target)
        .expect_err("the rebalance is refused")
        .code()
}

#[test]
fn a_saved_partition_numbered_past_the_limit_is_refused() {
    let scratch = ScratchDirectory::new("partition-number");
    saved_index(scratch.path());
    let manifest = scratch.path().join(INDEX).join("manifest");
    rewrite(
        &manifest,
        &[
            "renumber-partition",
            manifest.to_str().expect("a UTF-8 path"),
            &(SAVED_PARTITIONS - 1).to_string(),
            &PARTITION_LIMIT.to_string(),
        ],
    );
    let error = match Narsil::open(durable(scratch.path())) {
        Err(error) => error,
        Ok(engine) => engine
            .get_stats(INDEX)
            .expect_err("the damaged index stays closed"),
    };
    assert_eq!(error.code(), ErrorCode::PERSISTENCE_LOAD_FAILED);
    assert!(
        error.message().contains(&PARTITION_LIMIT.to_string()),
        "the refusal names the partition: {}",
        error.message()
    );
}

#[test]
fn an_index_saved_with_more_partitions_than_its_max_partitions_still_loads() {
    let scratch = ScratchDirectory::new("partition-surplus");
    let model = saved_index(scratch.path());
    rewrite_stored_max_partitions(scratch.path(), SMALLER_LIMIT);
    let engine = Narsil::open(durable(scratch.path())).expect("the engine reopens");
    assert_eq!(
        engine
            .get_stats(INDEX)
            .expect("the stats read")
            .partition_count,
        SAVED_PARTITIONS as usize,
        "every saved partition loads"
    );
    require_every_document(&engine, &model, "after the restart");
    assert_eq!(
        rebalance_code(&engine, SMALLER_LIMIT as usize + 1),
        ErrorCode::PARTITION_CAPACITY_EXCEEDED
    );
    engine
        .rebalance(INDEX, SMALLER_LIMIT as usize)
        .expect("a rebalance within maxPartitions succeeds");
    require_every_document(&engine, &model, "after the rebalance");
    engine.shutdown().expect("the engine shuts down");
}

#[test]
fn an_index_without_max_partitions_rebalances_past_one_only_after_the_limit_rises() {
    let engine = Narsil::new();
    let mut schema = Map::new();
    schema.insert("title", Value::String("string".into()));
    engine
        .create_index(
            INDEX,
            IndexConfig {
                schema: Value::Object(schema),
                ..IndexConfig::default()
            },
        )
        .expect("the index is created");
    let mut model = BTreeMap::new();
    for number in 0..DOCUMENTS {
        let id = format!("item-{number}");
        let mut document = Map::new();
        document.insert("id", Value::String(id.clone()));
        document.insert("title", Value::String(title_of(number)));
        engine
            .insert(INDEX, document, None)
            .expect("the document is stored");
        model.insert(id, title_of(number));
    }
    assert_eq!(
        rebalance_code(&engine, 2),
        ErrorCode::PARTITION_CAPACITY_EXCEEDED
    );
    assert_eq!(
        engine
            .get_stats(INDEX)
            .expect("the stats read")
            .partition_count,
        1,
        "a refused rebalance keeps one partition"
    );
    require_every_document(&engine, &model, "after the refused rebalance");
    engine
        .update_partition_config(
            INDEX,
            &PartitionConfig {
                max_partitions: Some(SMALLER_LIMIT),
                ..PartitionConfig::default()
            },
        )
        .expect("the limit rises");
    assert_eq!(
        rebalance_code(&engine, SMALLER_LIMIT as usize + 1),
        ErrorCode::PARTITION_CAPACITY_EXCEEDED
    );
    engine
        .rebalance(INDEX, SMALLER_LIMIT as usize)
        .expect("a rebalance within the raised limit succeeds");
    require_every_document(&engine, &model, "after the rebalance");
}

#[test]
fn a_stored_max_partitions_past_the_limit_loads_as_the_limit() {
    let scratch = ScratchDirectory::new("partition-ceiling");
    let model = saved_index(scratch.path());
    rewrite_stored_max_partitions(scratch.path(), STORED_PAST_THE_LIMIT);
    let engine = Narsil::open(durable(scratch.path())).expect("the engine reopens");
    require_every_document(&engine, &model, "after the restart");
    assert_eq!(
        rebalance_code(&engine, PARTITION_LIMIT as usize + 1),
        ErrorCode::PARTITION_CAPACITY_EXCEEDED
    );
    let refused = engine
        .create_index("fresh", partitioned(PARTITION_LIMIT + 1))
        .expect_err("a new index past the limit is refused");
    assert_eq!(refused.code(), ErrorCode::CONFIG_INVALID);
    engine.shutdown().expect("the engine shuts down");
}
