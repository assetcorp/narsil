mod support;

use std::collections::BTreeMap;

use narsil::{
    DurabilityConfig, DurabilityMode, IndexConfig, Map, Narsil, NarsilConfig, PartitionConfig,
    Storage, Value,
};
use support::ScratchDirectory;

#[test]
fn recovery_uses_the_committed_rebalance_when_metadata_keeps_the_earlier_partition_count() {
    for storage in [Storage::Memory, Storage::Disk] {
        let root = ScratchDirectory::new("cutover-recovery");
        let config = NarsilConfig {
            durability: Some(DurabilityConfig {
                directory: Some(root.path().to_path_buf()),
                mode: Some(DurabilityMode::Sync),
                checkpoint_interval_ms: Some(0),
                ..DurabilityConfig::default()
            }),
            ..NarsilConfig::default()
        };
        let narsil = Narsil::open(config.clone()).expect("the engine opens");
        let mut schema = Map::new();
        schema.insert("body", Value::String("string".into()));
        narsil
            .create_index(
                "letters",
                IndexConfig {
                    schema: Value::Object(schema),
                    text_storage: Some(storage),
                    partitions: Some(PartitionConfig {
                        max_partitions: Some(2),
                        ..PartitionConfig::default()
                    }),
                    ..IndexConfig::default()
                },
            )
            .expect("the index is created");
        let mut expected = BTreeMap::new();
        let documents = (0..20)
            .map(|at| {
                let id = format!("letter-{at}");
                let body = format!("stored letter {at}");
                expected.insert(id.clone(), body.clone());
                let mut document = Map::new();
                document.insert("id", Value::String(id));
                document.insert("body", Value::String(body));
                document
            })
            .collect();
        let inserted = narsil
            .insert_batch("letters", documents)
            .expect("the batch applies");
        assert!(inserted.failed.is_empty());
        narsil
            .checkpoint("letters")
            .expect("the checkpoint commits");
        let path = root.path().join("letters/meta");
        let earlier = std::fs::read(&path).expect("the metadata reads");
        narsil
            .rebalance("letters", 1)
            .expect("the rebalance commits");
        narsil.shutdown().expect("the engine shuts down");
        std::fs::write(&path, &earlier).expect("the earlier metadata replaces the file");
        let narsil = Narsil::open(config).expect("the engine reopens");
        for (id, body) in &expected {
            let document = narsil
                .get("letters", id)
                .expect("the read succeeds")
                .unwrap_or_else(|| panic!("recovery lost {id}"));
            assert_eq!(document.get("body"), Some(&Value::String(body.clone())));
        }
        let stats = narsil.get_stats("letters").expect("the statistics read");
        assert_eq!(stats.partition_count, 1);
        assert_eq!(stats.document_count, expected.len() as u64);
        assert_ne!(std::fs::read(&path).expect("the metadata reads"), earlier);
        narsil.shutdown().expect("the recovered engine shuts down");
    }
}
