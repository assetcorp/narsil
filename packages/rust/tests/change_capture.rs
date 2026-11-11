mod support;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use narsil::{ChangeType, ChangesEvent, ChangesRequest, FieldTests, Filter, Narsil};
use support::ScratchDirectory;
use support::changes::{
    FEED_WAIT, INDEX, Oracle, Subscriber, capture, files_under, first_event, heads_of, log_config,
    open_orders, order, read_export,
};

const SEGMENT_VERSION_AT: usize = 4;

fn write_mixed(narsil: &Narsil, oracle: &mut Oracle, prefix: &str, count: usize) {
    for at in 0..count {
        let id = format!("{prefix}{at}");
        oracle.insert(
            narsil,
            &id,
            order(&format!("order {id}"), "open", at as f64),
        );
        if at % 3 == 0 {
            oracle.update(
                narsil,
                &id,
                order(&format!("order {id}"), "closed", at as f64 + 0.5),
            );
        }
        if at % 5 == 0 {
            oracle.remove(narsil, &id);
        }
    }
}

#[test]
fn a_program_rebuilds_every_write_from_an_export_and_the_changes_after_it() {
    let scratch = ScratchDirectory::new("changes-rebuild");
    let root = scratch.path().join("data");
    let narsil = open_orders(&root, 3, &capture(true));
    let mut oracle = Oracle::default();
    write_mixed(&narsil, &mut oracle, "a", 40);
    let mut subscriber = Subscriber::from_export(&narsil, true);
    assert_eq!(
        subscriber.copy, oracle.documents,
        "the export holds every document"
    );
    let header = read_export(&narsil);
    assert_eq!(
        header.header_keys,
        ["format", "version", "index", "epoch", "positions"],
        "the header keys follow the specification's order"
    );
    assert_eq!(
        header.positions.len(),
        3,
        "the header holds a position for each partition"
    );
    let status = narsil
        .get_changes_setting(INDEX)
        .expect("the setting reads");
    assert_eq!(status.epoch.as_deref(), Some(subscriber.epoch.as_str()));

    write_mixed(&narsil, &mut oracle, "b", 60);
    let batch_id = "rewritten";
    oracle.insert(&narsil, batch_id, order("rewritten order", "open", 7.0));
    let first = order("first rewrite", "open", 8.0);
    let second = order("second rewrite", "closed", 9.0);
    narsil
        .update_batch(
            INDEX,
            vec![
                (batch_id.to_string(), first),
                (batch_id.to_string(), second.clone()),
            ],
        )
        .expect("the batch applies");
    oracle
        .documents
        .insert(batch_id.to_string(), support::changes::plain(&second));
    narsil.checkpoint(INDEX).expect("the checkpoint applies");
    let removed: Vec<String> = ["b2", "b4", "b7"].iter().map(|id| id.to_string()).collect();
    narsil
        .remove_batch(INDEX, removed.clone())
        .expect("the removals apply");
    for id in &removed {
        oracle.documents.remove(id);
    }
    narsil.shutdown().expect("the engine shuts down");

    let narsil = Narsil::open(log_config(&root)).expect("the engine reopens");
    let reopened = narsil
        .get_changes_setting(INDEX)
        .expect("the setting reads");
    assert!(
        reopened.enabled && reopened.previous_document,
        "the setting survives a restart"
    );
    assert_eq!(reopened.epoch, status.epoch, "a restart keeps the epoch");
    write_mixed(&narsil, &mut oracle, "c", 30);

    let mut feed = narsil
        .changes(INDEX, &subscriber.request())
        .expect("the feed opens");
    let ChangesEvent::Subscribed(subscribed) = first_event(&mut feed) else {
        panic!("the feed opens with its subscribed event");
    };
    assert_eq!(
        Some(subscribed.positions.clone()),
        subscriber.request().positions
    );
    assert!(subscribed.previous_document && subscribed.bytes_behind > 0);
    subscriber.follow_to(&mut feed, &heads_of(&narsil));
    assert_eq!(
        subscriber.copy, oracle.documents,
        "the changes rebuild every write"
    );
    let kinds: Vec<ChangeType> = subscriber
        .applied
        .iter()
        .map(|change| change.change_type)
        .collect();
    for kind in [ChangeType::Insert, ChangeType::Update, ChangeType::Remove] {
        assert!(kinds.contains(&kind), "the writes produce a {kind:?}");
    }
    let rewrites: Vec<_> = subscriber
        .applied
        .iter()
        .filter(|change| change.document_id == batch_id && change.change_type == ChangeType::Update)
        .collect();
    assert_eq!(
        rewrites.len(),
        2,
        "each write of the batch is its own change"
    );
}

#[test]
fn a_feed_follows_writes_from_another_thread_through_checkpoints_until_stopped() {
    let scratch = ScratchDirectory::new("changes-follow");
    let root = scratch.path().join("data");
    let narsil = Arc::new(open_orders(&root, 2, &capture(true)));
    let mut oracle = Oracle::default();
    write_mixed(&narsil, &mut oracle, "s", 20);
    let mut feed = narsil
        .changes(INDEX, &ChangesRequest::default())
        .expect("the feed opens at the heads");
    let mut subscriber = Subscriber::from_export(&narsil, true);
    subscriber.copy = oracle.documents.clone();
    subscriber.positions.clear();
    let ChangesEvent::Subscribed(subscribed) = first_event(&mut feed) else {
        panic!("the feed opens with its subscribed event");
    };
    assert_eq!(
        subscribed.positions, subscribed.heads,
        "a feed without positions starts at the heads"
    );
    subscriber.subscribed(&subscribed);

    let writer_engine = Arc::clone(&narsil);
    let writer = thread::spawn(move || {
        let mut written = Oracle {
            documents: oracle.documents,
        };
        for round in 0..6 {
            write_mixed(&writer_engine, &mut written, &format!("w{round}-"), 40);
            writer_engine
                .checkpoint(INDEX)
                .expect("the checkpoint applies");
        }
        written
    });
    let started = Instant::now();
    while !writer.is_finished() {
        assert!(started.elapsed() < FEED_WAIT * 4, "the writer finishes");
        match feed.next_within(Duration::from_millis(200)) {
            Some(Ok(ChangesEvent::Changes(group))) => subscriber.apply(&group),
            Some(other) => panic!("the feed returns only changes while it follows, not {other:?}"),
            None => {}
        }
    }
    let oracle = writer.join().expect("the writer succeeds");
    subscriber.follow_to(&mut feed, &heads_of(&narsil));
    assert_eq!(
        subscriber.copy, oracle.documents,
        "the feed follows every write"
    );

    let stopper = feed.stopper();
    let reading = thread::spawn(move || {
        let waited = Instant::now();
        let next = feed.next();
        (next.is_none(), feed.is_finished(), waited.elapsed())
    });
    thread::sleep(Duration::from_millis(200));
    stopper.stop();
    let (ended, finished, waited) = reading.join().expect("the reader succeeds");
    assert!(ended && finished, "a stopped feed ends");
    assert!(waited < FEED_WAIT, "a stop wakes a waiting feed");
}

fn segment_files(root: &Path) -> Vec<PathBuf> {
    files_under(&root.join(INDEX).join("wal"))
        .into_iter()
        .filter(|path| path.file_name().is_some_and(|name| name != "commit"))
        .collect()
}

fn holds_previous_key(bytes: &[u8]) -> bool {
    bytes
        .windows(b"previousDocument".len())
        .any(|window| window == b"previousDocument")
}

fn framing_of(root: &Path) -> Vec<(u8, bool)> {
    segment_files(root)
        .iter()
        .map(|path| {
            let bytes = std::fs::read(path).expect("the segment reads");
            (bytes[SEGMENT_VERSION_AT], holds_previous_key(&bytes))
        })
        .collect()
}

#[test]
fn only_an_index_that_records_previous_documents_writes_the_new_log_framing() {
    let scratch = ScratchDirectory::new("changes-framing");
    let root = scratch.path().join("data");
    let narsil = Narsil::open(log_config(&root)).expect("the engine opens");
    narsil
        .create_index(INDEX, support::changes::order_index())
        .expect("the index is created");
    let mut oracle = Oracle::default();
    write_mixed(&narsil, &mut oracle, "off", 30);
    narsil
        .update_changes(INDEX, &capture(false))
        .expect("capture turns on");
    write_mixed(&narsil, &mut oracle, "plain", 30);
    let before = framing_of(&root);
    assert!(!before.is_empty());
    assert!(
        before
            .iter()
            .all(|(version, keyed)| *version == 1 && !keyed),
        "entries without previous documents keep the version 1 bytes: {before:?}"
    );
    narsil
        .update_changes(INDEX, &capture(true))
        .expect("previous documents turn on");
    write_mixed(&narsil, &mut oracle, "keyed", 30);
    let after = framing_of(&root);
    assert!(
        after.iter().all(|(version, keyed)| !keyed || *version == 2),
        "every segment that holds a previous document has version 2: {after:?}"
    );
    assert!(after.iter().any(|(version, keyed)| *version == 2 && *keyed));
    narsil.shutdown().expect("the engine shuts down");

    let narsil = Narsil::open(log_config(&root)).expect("recovery reads both framings");
    assert_eq!(
        narsil.count_documents(INDEX).expect("the count answers"),
        oracle.documents.len() as u64
    );
    for (id, wanted) in &oracle.documents {
        let held = narsil
            .get(INDEX, id)
            .expect("the read answers")
            .expect("the document survives");
        assert_eq!(
            &support::changes::plain(&held),
            wanted,
            "recovery replays {id}"
        );
    }
}

#[test]
fn a_filtered_feed_holds_exactly_the_documents_that_match_before_and_after_each_write() {
    let scratch = ScratchDirectory::new("changes-filter");
    let root = scratch.path().join("data");
    let narsil = open_orders(&root, 2, &capture(false));
    let mut oracle = Oracle::default();
    for at in 0..40 {
        let status = if at % 2 == 0 { "open" } else { "closed" };
        oracle.insert(
            &narsil,
            &format!("f{at}"),
            order("order", status, at as f64),
        );
    }
    let mut subscriber = Subscriber::from_export(&narsil, false);
    subscriber.copy = oracle.matching("open");
    for at in 0..20 {
        let id = format!("f{at}");
        let status = if at % 2 == 0 { "closed" } else { "open" };
        oracle.update(&narsil, &id, order("flipped while off", status, at as f64));
    }
    oracle.remove(&narsil, "f38");
    narsil
        .update_changes(INDEX, &capture(true))
        .expect("previous documents turn on");
    for at in 10..30 {
        let id = format!("f{at}");
        let status = if at % 3 == 0 { "open" } else { "closed" };
        oracle.update(
            &narsil,
            &id,
            order("flipped while on", status, at as f64 + 1.0),
        );
    }
    oracle.remove(&narsil, "f12");
    oracle.remove(&narsil, "f13");
    for at in 40..60 {
        oracle.insert(
            &narsil,
            &format!("f{at}"),
            order("closed late", "closed", at as f64),
        );
    }
    let mut request = subscriber.request();
    request.filter = Some(Filter::field("status", FieldTests::new().eq("open")));
    let mut feed = narsil
        .changes(INDEX, &request)
        .expect("the filtered feed opens");
    subscriber.follow_to(&mut feed, &heads_of(&narsil));
    assert_eq!(
        subscriber.copy,
        oracle.matching("open"),
        "the copy holds the matching documents"
    );
    let open = narsil::Value::String("open".into());
    for change in &subscriber.applied {
        let after_matches = change
            .document
            .as_ref()
            .map(|document| document.get("status") == Some(&open));
        assert_ne!(
            after_matches,
            Some(false),
            "a change never carries a document after the write that misses"
        );
        let before_matches = change
            .previous_document
            .as_ref()
            .map(|document| document.get("status") == Some(&open));
        assert_ne!(
            before_matches,
            Some(false),
            "a change never carries a previous document that misses"
        );
    }
}
