mod support;

use std::path::Path;

use narsil::{DurabilityConfig, ErrorCode, IndexConfig, Map, Narsil, NarsilConfig, Storage, Value};
use support::{ScratchDirectory, rewrite_saved_file};

const INDEX: &str = "invoices";
const DOCUMENTS: u64 = 120;
const FALSE_DOCUMENT_COUNT: &str = "0";

fn durable(root: &Path) -> NarsilConfig {
    NarsilConfig {
        durability: Some(DurabilityConfig {
            directory: Some(root.to_path_buf()),
            ..DurabilityConfig::default()
        }),
        ..NarsilConfig::default()
    }
}

fn saved_index(root: &Path, storage: Storage) {
    let engine = Narsil::open(durable(root)).expect("the engine opens");
    let mut schema = Map::new();
    schema.insert("title", Value::String("string".into()));
    engine
        .create_index(
            INDEX,
            IndexConfig {
                schema: Value::Object(schema),
                text_storage: Some(storage),
                ..IndexConfig::default()
            },
        )
        .expect("the index is created");
    let documents = (0..DOCUMENTS)
        .map(|number| {
            let mut document = Map::new();
            document.insert("id", Value::String(format!("invoice-{number}")));
            document.insert(
                "title",
                Value::String(format!("invoice {number} for freight and handling")),
            );
            document
        })
        .collect();
    let stored = engine
        .insert_batch(INDEX, documents)
        .expect("the documents are stored");
    assert!(stored.failed.is_empty(), "every document is stored");
    engine.checkpoint(INDEX).expect("the checkpoint is written");
    engine.shutdown().expect("the engine shuts down");
}

fn refuses_false_segment_counts(storage: Storage, label: &str) {
    let scratch = ScratchDirectory::new(label);
    saved_index(scratch.path(), storage);
    let manifest = scratch.path().join(INDEX).join("manifest");
    rewrite_saved_file(
        &manifest,
        &[
            "segment-counts",
            manifest.to_str().expect("a UTF-8 path"),
            FALSE_DOCUMENT_COUNT,
        ],
    );
    let error = match Narsil::open(durable(scratch.path())) {
        Err(error) => error,
        Ok(engine) => engine
            .get_stats(INDEX)
            .expect_err("the index with false counts stays closed"),
    };
    assert_eq!(error.code(), ErrorCode::PERSISTENCE_LOAD_FAILED);
    assert!(
        error.message().contains("where the manifest lists 0"),
        "the refusal gives the listed count: {}",
        error.message()
    );
}

#[test]
fn a_manifest_listing_false_document_counts_is_refused() {
    refuses_false_segment_counts(Storage::Memory, "segment-counts-memory");
}

#[test]
fn a_manifest_listing_false_document_counts_is_refused_for_text_on_disk() {
    refuses_false_segment_counts(Storage::Disk, "segment-counts-disk");
}
