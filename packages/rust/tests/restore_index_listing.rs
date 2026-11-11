mod support;

use std::sync::Barrier;
use std::sync::atomic::{AtomicBool, Ordering};

use narsil::{IndexConfig, Map, Storage, Value, parse_json};
use support::ScratchDirectory;
use support::portable::{Tier, snapshot_of};

const INDEX: &str = "notes";
const RESTORES: usize = 12;

#[test]
fn an_index_listing_never_reports_the_empty_partitions_of_a_restore() {
    let root = ScratchDirectory::new("restore-index-listing");
    let target = Tier::Log.open(root.path());
    target
        .create_index(
            INDEX,
            IndexConfig {
                schema: parse_json(r#"{"title":"string"}"#).unwrap(),
                text_storage: Some(Storage::Disk),
                ..IndexConfig::default()
            },
        )
        .unwrap();
    let mut document = Map::new();
    document.insert("title", Value::String("harbour".into()));
    target.insert(INDEX, document, Some("kept")).unwrap();
    let archive = snapshot_of(&target, INDEX);
    let started = Barrier::new(2);
    let finished = AtomicBool::new(false);
    let incorrect = std::thread::scope(|scope| {
        let reader = scope.spawn(|| {
            started.wait();
            while !finished.load(Ordering::Acquire) {
                let listed = target.list_indexes();
                if listed.len() != 1 || listed[0].document_count != 1 {
                    return Some(listed);
                }
                std::thread::yield_now();
            }
            None
        });
        started.wait();
        for _ in 0..RESTORES {
            target.restore(INDEX, &mut archive.as_slice()).unwrap();
        }
        finished.store(true, Ordering::Release);
        reader.join().unwrap()
    });
    assert_eq!(target.count_documents(INDEX).unwrap(), 1);
    target.shutdown().unwrap();
    assert_eq!(incorrect, None, "the listing exposed an incomplete index");
}
