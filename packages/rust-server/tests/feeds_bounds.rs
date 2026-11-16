mod feeds_support;
mod support;

use std::time::Duration;

use feeds_support::{
    Event, INDEX, RustFeeds, Setup, Socket, Target, ack, field, kind_of, list, next_event, number,
    positions, quiet_for, send_value, subscribe_socket, until_closed,
};
use narsil::{Bm25Params, IndexResidencyState, SynonymRule, Value};
use support::object;

const SYNC_SUBPROTOCOL: &str = "narsil.sync.v1";
const CHANGES_SUBPROTOCOL: &str = "narsil.changes.v1";
const GRANT_MS: u64 = 1_000;
const HELD_PAST_GRANT: Duration = Duration::from_millis(1_500);
const QUIET: Duration = Duration::from_millis(600);
const DRAIN_QUIET: Duration = Duration::from_secs(2);
const SYNONYM_RULES: usize = 6_000;
const SETTINGS_UPDATES: usize = 60;
const MOST_SETTINGS_DELIVERED: usize = SETTINGS_UPDATES / 2;

fn feed_path(feed: &str) -> String {
    format!("/indexes/{INDEX}/{feed}/feed")
}

fn subscribe_at(epoch: &str, seq_nos: &[u64]) -> Value {
    object(vec![
        ("type", Value::String("subscribe".into())),
        ("epoch", Value::String(epoch.to_string())),
        ("positions", positions(seq_nos)),
    ])
}

async fn subscribed(port: u16, epoch: &str, seq_nos: &[u64]) -> (Socket, Value) {
    let mut socket = subscribe_socket(port, &feed_path("sync"), SYNC_SUBPROTOCOL).await;
    send_value(&mut socket, &subscribe_at(epoch, seq_nos)).await;
    match next_event(&mut socket).await {
        Event::Message(answer) if kind_of(&answer) == "subscribed" => (socket, answer),
        other => panic!("the sync feed answers subscribe, not {other:?}"),
    }
}

async fn seq_nos_through(socket: &mut Socket, last: u64) -> Vec<u64> {
    let mut seen = Vec::new();
    while seen.last().is_none_or(|seq_no| *seq_no < last) {
        match next_event(socket).await {
            Event::Message(message) if kind_of(&message) == "entries" => seen.extend(
                list(&message, "entries")
                    .iter()
                    .map(|entry| number(entry, "seqNo") as u64),
            ),
            Event::Message(_) => {}
            Event::Closed(close) => panic!("the feed closes with {close:?} before entry {last}"),
        }
    }
    seen
}

fn head_of(subscribed: &Value) -> u64 {
    list(subscribed, "heads")
        .first()
        .map(|head| number(head, "seqNo") as u64)
        .expect("the answer gives the head of partition 0")
}

fn residency(rust: &RustFeeds) -> (IndexResidencyState, u64) {
    rust.engine
        .list_indexes()
        .into_iter()
        .find(|info| info.name == INDEX)
        .map(|info| (info.state, info.reopen_count))
        .expect("the engine lists the index")
}

#[test]
fn a_feed_sends_nothing_once_its_credential_expires_while_the_server_is_busy() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .max_blocking_threads(1)
        .enable_all()
        .build()
        .expect("the runtime starts");
    runtime.block_on(async {
        let rust = RustFeeds::start(Setup {
            grant_ms: Some(GRANT_MS),
            ..Setup::new()
        })
        .await;
        let target = Target::Rust(&rust);
        target.create_index(INDEX).await;
        target.set_sync(true).await;
        target.set_changes(true, false).await;
        target.insert("private", "secret").await;
        let sync_epoch = target.sync_epoch().await;
        let changes_epoch = rust
            .engine
            .get_changes_setting(INDEX)
            .expect("the change capture setting reads")
            .epoch
            .expect("change capture is on");
        let feeds = [
            ("sync", SYNC_SUBPROTOCOL, sync_epoch),
            ("changes", CHANGES_SUBPROTOCOL, changes_epoch),
        ];
        for (feed, subprotocol, epoch) in feeds {
            let mut socket = subscribe_socket(rust.port, &feed_path(feed), subprotocol).await;
            let (started, holding) = tokio::sync::oneshot::channel();
            let (release, released) = std::sync::mpsc::channel::<()>();
            let hold = tokio::task::spawn_blocking(move || {
                let _ = started.send(());
                let _ = released.recv();
            });
            holding.await.expect("the only blocking thread holds");
            send_value(&mut socket, &subscribe_at(&epoch, &[0])).await;
            tokio::time::sleep(HELD_PAST_GRANT).await;
            let _ = release.send(());
            hold.await.expect("the hold ends");
            let (messages, close) = until_closed(&mut socket).await;
            assert_eq!(
                messages,
                Vec::<Value>::new(),
                "the {feed} feed sends nothing"
            );
            assert_eq!(close, Some((4401, "credential expired".to_string())));
        }
        rust.server.shutdown().await.expect("the server shuts down");
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_device_that_stops_reading_queues_a_bounded_number_of_settings() {
    let rust = RustFeeds::start(Setup {
        max_buffered_bytes: Some(1_024),
        ..Setup::new()
    })
    .await;
    let target = Target::Rust(&rust);
    target.create_index(INDEX).await;
    target.set_sync(true).await;
    let epoch = target.sync_epoch().await;
    let (mut socket, _) = subscribed(rust.port, &epoch, &[0]).await;
    let rules: Vec<SynonymRule> = (0..SYNONYM_RULES)
        .map(|at| {
            SynonymRule::TwoWay(vec![
                format!("{}q{at}", "k".repeat(64)),
                format!("{}r{at}", "m".repeat(64)),
            ])
        })
        .collect();
    rust.engine
        .update_synonyms(INDEX, &rules)
        .expect("the synonyms change");
    for k1 in 1..=SETTINGS_UPDATES {
        let bm25 = Bm25Params {
            k1: Some(k1 as f64),
            ..Bm25Params::default()
        };
        rust.engine
            .update_bm25(INDEX, &bm25)
            .expect("the BM25 parameters change");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    tokio::time::sleep(QUIET).await;
    let mut settings = Vec::new();
    while let Some(Event::Message(message)) = quiet_for(&mut socket, DRAIN_QUIET).await {
        if kind_of(&message) == "settings" {
            settings.push(message);
        }
    }
    assert!(
        settings.len() <= MOST_SETTINGS_DELIVERED,
        "{} settings messages queued for one device",
        settings.len()
    );
    let newest = settings
        .last()
        .and_then(|message| field(message, "settings"))
        .and_then(|settings| field(settings, "bm25"))
        .map(|bm25| number(bm25, "k1"));
    assert_eq!(newest, Some(SETTINGS_UPDATES as f64));
    rust.server.shutdown().await.expect("the server shuts down");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_device_acknowledgement_leaves_a_closed_index_closed() {
    let rust = RustFeeds::start(Setup::new()).await;
    let target = Target::Rust(&rust);
    target.create_index(INDEX).await;
    target.set_sync(true).await;
    for id in ["a", "b", "c"] {
        target.insert(id, "keep").await;
    }
    let epoch = target.sync_epoch().await;
    let (mut socket, _) = subscribed(rust.port, &epoch, &[0]).await;
    assert_eq!(seq_nos_through(&mut socket, 3).await, vec![1, 2, 3]);
    rust.engine.close_index(INDEX).expect("the index closes");
    send_value(&mut socket, &ack(&[3])).await;
    assert_eq!(quiet_for(&mut socket, QUIET).await, None);
    let (mut late, answer) = subscribed(rust.port, &epoch, &[3]).await;
    assert_eq!(head_of(&answer), 3);
    send_value(&mut late, &ack(&[3])).await;
    assert_eq!(quiet_for(&mut late, QUIET).await, None);
    assert_eq!(residency(&rust), (IndexResidencyState::Closed, 0));
    target.insert("d", "keep").await;
    assert_eq!(seq_nos_through(&mut socket, 4).await, vec![4]);
    assert_eq!(seq_nos_through(&mut late, 4).await, vec![4]);
    rust.server.shutdown().await.expect("the server shuts down");
}
