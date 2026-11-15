mod feeds_support;
mod support;

use std::time::Duration;

use bytes::Bytes;
use feeds_support::{
    Event, INDEX, Offer, ReferenceFeeds, RustFeeds, Setup, Socket, Target, ack, kind_of, list,
    next_event, number, open, positions, quiet_for, refusal_parts, send_raw, send_value,
    subscribe_socket, text, until_closed,
};
use narsil::Value;
use support::{Call, object, send};
use tokio_tungstenite::tungstenite::Message;

const SUBPROTOCOL: &str = "narsil.sync.v1";
const QUIET: Duration = Duration::from_millis(600);

fn feed_path() -> String {
    format!("/indexes/{INDEX}/sync/feed")
}

fn subscribe(epoch: &str, seq_nos: &[u64]) -> Value {
    object(vec![
        ("type", Value::String("subscribe".into())),
        ("epoch", Value::String(epoch.to_string())),
        ("positions", positions(seq_nos)),
    ])
}

async fn pair(setup: Setup) -> (RustFeeds, ReferenceFeeds) {
    let rust = RustFeeds::start(setup).await;
    let reference = ReferenceFeeds::start(setup).await;
    for target in [Target::Rust(&rust), Target::Reference(&reference)] {
        target.create_index(INDEX).await;
        target.set_sync(true).await;
    }
    (rust, reference)
}

type Outcome = (Vec<String>, Option<(u16, String)>);

fn outcome_of(messages: &[Value], close: Option<(u16, String)>) -> Outcome {
    (messages.iter().map(kind_of).collect(), close)
}

async fn subscribed_socket(target: &Target<'_>, seq_nos: &[u64]) -> (Socket, Value) {
    let epoch = target.sync_epoch().await;
    let mut socket = subscribe_socket(target.port(), &feed_path(), SUBPROTOCOL).await;
    send_value(&mut socket, &subscribe(&epoch, seq_nos)).await;
    let answer = match next_event(&mut socket).await {
        Event::Message(answer) => answer,
        Event::Closed(close) => panic!("{} answers subscribe, not {close:?}", target.label()),
    };
    assert_eq!(kind_of(&answer), "subscribed", "{}", target.label());
    (socket, answer)
}

async fn entries_through(socket: &mut Socket, last: u64) -> Vec<Value> {
    let mut entries = Vec::new();
    while entries
        .last()
        .is_none_or(|entry: &Value| (number(entry, "seqNo") as u64) < last)
    {
        match next_event(socket).await {
            Event::Message(message) if kind_of(&message) == "entries" => {
                entries.extend(list(&message, "entries").iter().cloned());
            }
            Event::Message(_) => {}
            Event::Closed(close) => panic!("the feed closes with {close:?} before entry {last}"),
        }
    }
    entries
}

fn ids_of(entries: &[Value]) -> Vec<(u64, String, String)> {
    entries
        .iter()
        .map(|entry| {
            (
                number(entry, "seqNo") as u64,
                text(entry, "operation"),
                text(entry, "documentId"),
            )
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sync_feed_refuses_each_upgrade_as_the_typescript_server_does() {
    let (rust, reference) = pair(Setup::new()).await;
    for target in [Target::Rust(&rust), Target::Reference(&reference)] {
        target.create_index("plain").await;
    }
    let cases: Vec<(String, Offer<'_>, bool)> = vec![
        (feed_path(), Offer::Nothing, true),
        (feed_path(), Offer::Subprotocol(SUBPROTOCOL), false),
        (feed_path(), Offer::Subprotocol("narsil.other.v1"), true),
        (
            "/indexes/absent/sync/feed".into(),
            Offer::Subprotocol(SUBPROTOCOL),
            true,
        ),
        (
            "/indexes/plain/sync/feed".into(),
            Offer::Subprotocol(SUBPROTOCOL),
            true,
        ),
        (
            "/indexes/%E0%A4%A/sync/feed".into(),
            Offer::Subprotocol(SUBPROTOCOL),
            true,
        ),
    ];
    for (path, offer, authorized) in cases {
        let offered = match &offer {
            Offer::Subprotocol(subprotocol) => Offer::Subprotocol(subprotocol),
            Offer::Nothing => Offer::Nothing,
        };
        let mine = open(rust.port, &path, offer, authorized).await.err();
        let theirs = open(reference.port, &path, offered, authorized).await.err();
        let (Some(mine), Some(theirs)) = (mine, theirs) else {
            panic!("both servers refuse {path}");
        };
        assert_eq!(refusal_parts(&mine), refusal_parts(&theirs), "{path}");
    }
    let plain = Call::new("GET", "/indexes/notes/sync/feed").authorized();
    let mine = send(rust.port, &plain).await;
    let theirs = send(reference.port, &plain).await;
    assert_eq!((mine.status, mine.json()), (theirs.status, theirs.json()));
    rust.server.shutdown().await.expect("the server shuts down");
    reference.stop().await;
}

async fn hostile_outcomes(target: &Target<'_>) -> Vec<Outcome> {
    let epoch = target.sync_epoch().await;
    let path = feed_path();
    let port = target.port();
    let mut outcomes = Vec::new();
    let raw_cases = vec![
        Message::Text("subscribe".into()),
        Message::Binary(Bytes::from_static(&[0xc1])),
        Message::Binary(Bytes::from(vec![0x90; 70_000])),
        Message::Binary(Bytes::from(vec![0x90; 200_000])),
    ];
    for frame in raw_cases {
        let mut socket = subscribe_socket(port, &path, SUBPROTOCOL).await;
        send_raw(&mut socket, frame).await;
        let (messages, close) = until_closed(&mut socket).await;
        outcomes.push(outcome_of(&messages, close));
    }
    let checkpoint = object(vec![
        ("type", Value::String("checkpoint".into())),
        ("id", Value::Number(3.0)),
    ]);
    let duplicated = object(vec![
        ("type", Value::String("ack".into())),
        (
            "positions",
            Value::Array(vec![
                object(vec![
                    ("partitionId", Value::Number(0.0)),
                    ("seqNo", Value::Number(0.0)),
                ]),
                object(vec![
                    ("partitionId", Value::Number(0.0)),
                    ("seqNo", Value::Number(0.0)),
                ]),
            ]),
        ),
    ]);
    let message_cases: Vec<Vec<Value>> = vec![
        vec![ack(&[0])],
        vec![checkpoint],
        vec![subscribe("not-an-epoch", &[0])],
        vec![subscribe("0123456789abcdef0123456789ABCDEF", &[0])],
        vec![subscribe(&"0".repeat(32), &[0])],
        vec![subscribe(&epoch, &[])],
        vec![subscribe(&epoch, &[0, 0])],
        vec![subscribe(&epoch, &[1_000_000])],
        vec![subscribe(&epoch, &[3]), subscribe(&epoch, &[3])],
        vec![subscribe(&epoch, &[3]), ack(&[4])],
        vec![subscribe(&epoch, &[3]), duplicated],
        vec![object(vec![("type", Value::String("unknown".into()))])],
    ];
    for messages in message_cases {
        let mut socket = subscribe_socket(port, &path, SUBPROTOCOL).await;
        for message in &messages {
            send_value(&mut socket, message).await;
        }
        let (messages, close) = until_closed(&mut socket).await;
        outcomes.push(outcome_of(&messages, close));
    }
    outcomes
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sync_feed_closes_on_hostile_messages_as_the_typescript_server_does() {
    let (rust, reference) = pair(Setup::new()).await;
    for target in [Target::Rust(&rust), Target::Reference(&reference)] {
        for id in ["a", "b", "c"] {
            target.insert(id, "keep").await;
        }
    }
    let mine = hostile_outcomes(&Target::Rust(&rust)).await;
    let theirs = hostile_outcomes(&Target::Reference(&reference)).await;
    assert_eq!(mine, theirs);
    assert_eq!(
        mine.first().map(|outcome| outcome.1.clone()),
        Some(Some((
            1008,
            "feed messages travel in binary frames".to_string()
        )))
    );
    rust.server.shutdown().await.expect("the server shuts down");
    reference.stop().await;
}

async fn ordered_delivery(target: &Target<'_>) -> (Vec<(u64, String, String)>, Value) {
    for id in ["a0", "a1", "a2", "a3", "a4"] {
        target.insert(id, "keep").await;
    }
    let (mut socket, subscribed) = subscribed_socket(target, &[0]).await;
    let mut entries = entries_through(&mut socket, 5).await;
    for id in ["a5", "a6", "a7", "a8", "a9"] {
        target.insert(id, "keep").await;
    }
    entries.extend(entries_through(&mut socket, 10).await);
    send_value(&mut socket, &ack(&[10])).await;
    let checkpoint = object(vec![
        ("type", Value::String("checkpoint".into())),
        ("id", Value::Number(7.0)),
    ]);
    send_value(&mut socket, &checkpoint).await;
    let answer = loop {
        match next_event(&mut socket).await {
            Event::Message(message) if kind_of(&message) == "checkpoint" => break message,
            Event::Message(_) => {}
            Event::Closed(close) => panic!("the feed closes with {close:?} before the checkpoint"),
        }
    };
    assert_eq!(number(&answer, "id"), 7.0, "{}", target.label());
    let heads = list(&answer, "heads");
    assert!(
        heads
            .first()
            .is_some_and(|head| number(head, "seqNo") >= 10.0),
        "{} answers the checkpoint with heads that cover every write: {answer:?}",
        target.label()
    );
    let mut summary = subscribed;
    if let Value::Object(map) = &mut summary {
        map.remove("epoch");
        map.remove("bytesBehind");
        map.remove("snapshotBytes");
    }
    (ids_of(&entries), summary)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sync_feed_sends_every_write_in_order_and_answers_checkpoints() {
    let (rust, reference) = pair(Setup::new()).await;
    let (mine, my_subscribed) = ordered_delivery(&Target::Rust(&rust)).await;
    let (theirs, their_subscribed) = ordered_delivery(&Target::Reference(&reference)).await;
    let written: Vec<(u64, String, String)> = (0..10)
        .map(|at| (at + 1, "INDEX".to_string(), format!("a{at}")))
        .collect();
    assert_eq!(mine, written);
    assert_eq!(theirs, written);
    assert_eq!(my_subscribed, their_subscribed);
    rust.server.shutdown().await.expect("the server shuts down");
    reference.stop().await;
}

async fn windowed_delivery(target: &Target<'_>, count: usize) -> Vec<usize> {
    for at in 0..count {
        target.insert(&format!("w{at:03}"), "keep").await;
    }
    let (mut socket, _) = subscribed_socket(target, &[0]).await;
    let mut batches = Vec::new();
    let mut received: Vec<Value> = Vec::new();
    while received.len() < count {
        let mut batch = 0;
        while let Some(event) = quiet_for(&mut socket, QUIET).await {
            match event {
                Event::Message(message) if kind_of(&message) == "entries" => {
                    let entries = list(&message, "entries");
                    batch += entries.len();
                    received.extend(entries.iter().cloned());
                }
                Event::Message(_) => {}
                Event::Closed(close) => panic!("the feed closes with {close:?} mid-window"),
            }
        }
        assert!(
            batch > 0,
            "{} sends entries once acknowledged",
            target.label()
        );
        batches.push(batch);
        let last = received.last().map_or(0.0, |entry| number(entry, "seqNo"));
        send_value(&mut socket, &ack(&[last as u64])).await;
    }
    let order: Vec<String> = received
        .iter()
        .map(|entry| text(entry, "documentId"))
        .collect();
    let written: Vec<String> = (0..count).map(|at| format!("w{at:03}")).collect();
    assert_eq!(order, written, "{}", target.label());
    batches
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sync_feed_holds_entries_past_the_window_until_the_device_acknowledges() {
    let setup = Setup {
        window_bytes: Some(1_024),
        ..Setup::new()
    };
    let (rust, reference) = pair(setup).await;
    let mine = windowed_delivery(&Target::Rust(&rust), 40).await;
    let theirs = windowed_delivery(&Target::Reference(&reference), 40).await;
    assert!(mine.len() > 1, "the window splits 40 entries: {mine:?}");
    assert_eq!(mine, theirs);
    rust.server.shutdown().await.expect("the server shuts down");
    reference.stop().await;
}

async fn index_changes(target: &Target<'_>) -> Vec<Outcome> {
    let mut outcomes = Vec::new();
    let (mut socket, _) = subscribed_socket(target, &[0]).await;
    target.add_synonyms().await;
    let settings = match next_event(&mut socket).await {
        Event::Message(message) => kind_of(&message),
        Event::Closed(close) => panic!("{} closes with {close:?}", target.label()),
    };
    target.clear().await;
    let (mut messages, close) = until_closed(&mut socket).await;
    messages.insert(0, object(vec![("type", Value::String(settings))]));
    outcomes.push(outcome_of(&messages, close));
    let (mut socket, _) = subscribed_socket(target, &[0]).await;
    target.set_sync(false).await;
    let (messages, close) = until_closed(&mut socket).await;
    outcomes.push(outcome_of(&messages, close));
    target.set_sync(true).await;
    let (mut socket, _) = subscribed_socket(target, &[0]).await;
    target.drop_index().await;
    let (messages, close) = until_closed(&mut socket).await;
    outcomes.push(outcome_of(&messages, close));
    outcomes
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sync_feed_follows_settings_epochs_and_a_dropped_index() {
    let (rust, reference) = pair(Setup::new()).await;
    let mine = index_changes(&Target::Rust(&rust)).await;
    let theirs = index_changes(&Target::Reference(&reference)).await;
    assert_eq!(mine, theirs);
    assert_eq!(
        mine.last().map(|outcome| outcome.1.clone()),
        Some(Some((4410, "sync is off".to_string())))
    );
    rust.server.shutdown().await.expect("the server shuts down");
    reference.stop().await;
}

async fn crowd(target: &Target<'_>, attempts: usize) -> (usize, Vec<(u16, Value)>, Outcome) {
    let path = feed_path();
    let opening =
        (0..attempts).map(|_| open(target.port(), &path, Offer::Subprotocol(SUBPROTOCOL), true));
    let results = futures_util::future::join_all(opening).await;
    let mut sockets = Vec::new();
    let mut refusals = Vec::new();
    for result in results {
        match result {
            Ok(socket) => sockets.push(socket),
            Err(refusal) => refusals.push(refusal_parts(&refusal)),
        }
    }
    let admitted = sockets.len();
    drop(sockets);
    tokio::time::sleep(QUIET).await;
    let (mut socket, _) = subscribed_socket(target, &[0]).await;
    let (messages, close) = until_closed(&mut socket).await;
    (admitted, refusals, outcome_of(&messages, close))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sync_feed_caps_connections_and_closes_an_expired_grant() {
    let setup = Setup {
        max_connections: Some(40),
        grant_ms: Some(1_500),
        ..Setup::new()
    };
    let (rust, reference) = pair(setup).await;
    let mine = crowd(&Target::Rust(&rust), 60).await;
    let theirs = crowd(&Target::Reference(&reference), 60).await;
    assert_eq!(mine.0, 40);
    assert_eq!(mine.1.len(), 20);
    assert_eq!(mine, theirs);
    assert_eq!(mine.2.1, Some((4401, "credential expired".to_string())));
    rust.server.shutdown().await.expect("the server shuts down");
    reference.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn closing_the_server_closes_every_device_feed() {
    let rust = RustFeeds::start(Setup::new()).await;
    let target = Target::Rust(&rust);
    target.create_index(INDEX).await;
    target.set_sync(true).await;
    let mut sockets = Vec::new();
    for _ in 0..8 {
        sockets.push(subscribed_socket(&target, &[0]).await.0);
    }
    let started = std::time::Instant::now();
    rust.server.close().await;
    assert!(started.elapsed() < Duration::from_secs(10));
    for socket in &mut sockets {
        let (_, close) = until_closed(socket).await;
        assert_eq!(close, Some((1001, "server closing".to_string())));
    }
    rust.engine.shutdown().expect("the engine shuts down");
}
