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
use support::object;
use tokio_tungstenite::tungstenite::Message;

const SUBPROTOCOL: &str = "narsil.changes.v1";
const QUIET: Duration = Duration::from_millis(600);

type Outcome = (Vec<String>, Option<(u16, String)>);
type Seen = (u64, String, String);

fn feed_path() -> String {
    format!("/indexes/{INDEX}/changes/feed")
}

fn subscribe(resume: Option<(&str, &[u64])>, filter: Option<Value>) -> Value {
    let mut fields = vec![("type", Value::String("subscribe".into()))];
    if let Some((epoch, seq_nos)) = resume {
        fields.push(("epoch", Value::String(epoch.to_string())));
        fields.push(("positions", positions(seq_nos)));
    }
    if let Some(filter) = filter {
        fields.push(("filter", filter));
    }
    object(fields)
}

fn tag_is(tag: &str) -> Value {
    object(vec![(
        "fields",
        object(vec![(
            "tag",
            object(vec![("eq", Value::String(tag.into()))]),
        )]),
    )])
}

async fn pair(setup: Setup, previous_document: bool) -> (RustFeeds, ReferenceFeeds) {
    let rust = RustFeeds::start(setup).await;
    let reference = ReferenceFeeds::start(setup).await;
    for target in [Target::Rust(&rust), Target::Reference(&reference)] {
        target.create_index(INDEX).await;
        target.set_changes(true, previous_document).await;
    }
    (rust, reference)
}

fn outcome_of(messages: &[Value], close: Option<(u16, String)>) -> Outcome {
    (messages.iter().map(kind_of).collect(), close)
}

async fn subscribed_socket(target: &Target<'_>, filter: Option<Value>) -> (Socket, Value) {
    subscribed_with(target, subscribe(None, filter)).await
}

async fn subscribed_with(target: &Target<'_>, request: Value) -> (Socket, Value) {
    let mut socket = subscribe_socket(target.port(), &feed_path(), SUBPROTOCOL).await;
    send_value(&mut socket, &request).await;
    match next_event(&mut socket).await {
        Event::Message(answer) if kind_of(&answer) == "subscribed" => (socket, answer),
        other => panic!("{} answers subscribe, not {other:?}", target.label()),
    }
}

async fn changes_through(socket: &mut Socket, last: u64) -> (Vec<Seen>, u64) {
    let mut seen = Vec::new();
    let mut scanned = 0;
    while scanned < last {
        match next_event(socket).await {
            Event::Message(message) if kind_of(&message) == "changes" => {
                scanned = number(&message, "scannedSeqNo") as u64;
                for change in list(&message, "changes") {
                    seen.push((
                        number(change, "seqNo") as u64,
                        text(change, "type"),
                        text(change, "documentId"),
                    ));
                }
            }
            Event::Message(_) => {}
            Event::Closed(close) => panic!("the feed closes with {close:?} before {last}"),
        }
    }
    (seen, scanned)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn change_feed_refuses_each_upgrade_as_the_typescript_server_does() {
    let (rust, reference) = pair(Setup::new(), false).await;
    for target in [Target::Rust(&rust), Target::Reference(&reference)] {
        target.create_index("plain").await;
    }
    let cases: Vec<(String, Option<&str>, bool)> = vec![
        (feed_path(), None, true),
        (feed_path(), Some(SUBPROTOCOL), false),
        (feed_path(), Some("narsil.sync.v1"), true),
        (
            "/indexes/absent/changes/feed".into(),
            Some(SUBPROTOCOL),
            true,
        ),
        (
            "/indexes/plain/changes/feed".into(),
            Some(SUBPROTOCOL),
            true,
        ),
    ];
    for (path, offer, authorized) in cases {
        let offer_of = || offer.map_or(Offer::Nothing, Offer::Subprotocol);
        let mine = open(rust.port, &path, offer_of(), authorized).await.err();
        let theirs = open(reference.port, &path, offer_of(), authorized)
            .await
            .err();
        let (Some(mine), Some(theirs)) = (mine, theirs) else {
            panic!("both servers refuse {path}");
        };
        assert_eq!(refusal_parts(&mine), refusal_parts(&theirs), "{path}");
    }
    rust.server.shutdown().await.expect("the server shuts down");
    reference.stop().await;
}

async fn hostile_outcomes(target: &Target<'_>) -> Vec<Outcome> {
    let port = target.port();
    let path = feed_path();
    let (mut first, subscribed) = subscribed_socket(target, None).await;
    let epoch = text(&subscribed, "epoch");
    let _ = until_closed_after(&mut first, ack(&[1_000])).await;
    let mut outcomes = Vec::new();
    let raw_cases = vec![
        Message::Text("subscribe".into()),
        Message::Binary(Bytes::from_static(&[0xc1])),
        Message::Binary(Bytes::from(vec![0x90; 70_000])),
    ];
    for frame in raw_cases {
        let mut socket = subscribe_socket(port, &path, SUBPROTOCOL).await;
        send_raw(&mut socket, frame).await;
        let (messages, close) = until_closed(&mut socket).await;
        outcomes.push(outcome_of(&messages, close));
    }
    let epoch_alone = object(vec![
        ("type", Value::String("subscribe".into())),
        ("epoch", Value::String(epoch.clone())),
    ]);
    let regex = object(vec![(
        "fields",
        object(vec![(
            "title",
            object(vec![("regex", Value::String("^note".into()))]),
        )]),
    )]);
    let absent = object(vec![(
        "fields",
        object(vec![(
            "absent",
            object(vec![("eq", Value::String("x".into()))]),
        )]),
    )]);
    let message_cases: Vec<Vec<Value>> = vec![
        vec![ack(&[0])],
        vec![epoch_alone],
        vec![subscribe(Some(("not-an-epoch", &[0])), None)],
        vec![subscribe(Some((&"0".repeat(32), &[0])), None)],
        vec![subscribe(Some((&epoch, &[])), None)],
        vec![subscribe(Some((&epoch, &[1_000_000])), None)],
        vec![subscribe(None, Some(regex))],
        vec![subscribe(None, Some(absent))],
        vec![subscribe(None, Some(tag_is("keep")))],
        vec![subscribe(None, Some(Value::String("tag".into())))],
        vec![subscribe(None, None), subscribe(None, None)],
        vec![subscribe(None, None), ack(&[1_000])],
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

async fn until_closed_after(socket: &mut Socket, message: Value) -> Outcome {
    send_value(socket, &message).await;
    let (messages, close) = until_closed(socket).await;
    outcome_of(&messages, close)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn change_feed_closes_on_hostile_messages_as_the_typescript_server_does() {
    let setup = Setup {
        allow_regex: false,
        ..Setup::new()
    };
    let (rust, reference) = pair(setup, false).await;
    for target in [Target::Rust(&rust), Target::Reference(&reference)] {
        for id in ["a", "b", "c"] {
            target.insert(id, "keep").await;
        }
    }
    let mine = hostile_outcomes(&Target::Rust(&rust)).await;
    let theirs = hostile_outcomes(&Target::Reference(&reference)).await;
    assert_eq!(mine, theirs);
    rust.server.shutdown().await.expect("the server shuts down");
    reference.stop().await;
}

fn tag_of(at: usize) -> &'static str {
    if at.is_multiple_of(2) { "keep" } else { "skip" }
}

async fn ordered_delivery(target: &Target<'_>) -> (Vec<Seen>, Vec<Seen>, Vec<Seen>, Vec<Value>) {
    for at in 0..5 {
        target.insert(&format!("a{at}"), tag_of(at)).await;
    }
    let (mut present, fresh) = subscribed_socket(target, None).await;
    let epoch = text(&fresh, "epoch");
    let (mut history, resumed) =
        subscribed_with(target, subscribe(Some((&epoch, &[0])), None)).await;
    let (mut filtered, _) = subscribed_with(
        target,
        subscribe(Some((&epoch, &[0])), Some(tag_is("keep"))),
    )
    .await;
    for at in 5..10 {
        target.insert(&format!("a{at}"), tag_of(at)).await;
    }
    let (from_present, _) = changes_through(&mut present, 10).await;
    let (from_history, _) = changes_through(&mut history, 10).await;
    let last_kept = (0..10)
        .rfind(|at| tag_of(*at) == "keep")
        .map_or(0, |at| at as u64 + 1);
    let (kept, _) = changes_through(&mut filtered, last_kept).await;
    let summaries = [fresh, resumed]
        .into_iter()
        .map(|mut summary| {
            if let Value::Object(map) = &mut summary {
                map.remove("epoch");
                map.remove("bytesBehind");
            }
            summary
        })
        .collect();
    (from_present, from_history, kept, summaries)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn change_feed_sends_every_write_in_order_and_filters_by_document() {
    let (rust, reference) = pair(Setup::new(), true).await;
    let mine = ordered_delivery(&Target::Rust(&rust)).await;
    let theirs = ordered_delivery(&Target::Reference(&reference)).await;
    let ids = |seen: &[Seen]| -> Vec<String> { seen.iter().map(|seen| seen.2.clone()).collect() };
    let written = |from: usize| -> Vec<String> { (from..10).map(|at| format!("a{at}")).collect() };
    assert_eq!(ids(&mine.0), written(5));
    assert_eq!(ids(&mine.1), written(0));
    let seq_nos: Vec<u64> = mine.1.iter().map(|seen| seen.0).collect();
    assert_eq!(seq_nos, (1..=10).collect::<Vec<u64>>());
    let wanted: Vec<String> = (0..10)
        .filter(|at| tag_of(*at) == "keep")
        .map(|at| format!("a{at}"))
        .collect();
    assert_eq!(ids(&mine.2), wanted);
    assert_eq!(mine, theirs);
    rust.server.shutdown().await.expect("the server shuts down");
    reference.stop().await;
}

async fn windowed_delivery(target: &Target<'_>, count: usize) -> Vec<usize> {
    let (first, fresh) = subscribed_socket(target, None).await;
    drop(first);
    let epoch = text(&fresh, "epoch");
    for at in 0..count {
        target.insert(&format!("w{at:03}"), "keep").await;
    }
    let (mut socket, _) = subscribed_with(target, subscribe(Some((&epoch, &[0])), None)).await;
    let mut batches = Vec::new();
    let mut received = Vec::new();
    let mut scanned = 0;
    while received.len() < count {
        let mut batch = 0;
        while let Some(event) = quiet_for(&mut socket, QUIET).await {
            match event {
                Event::Message(message) if kind_of(&message) == "changes" => {
                    scanned = number(&message, "scannedSeqNo") as u64;
                    let changes = list(&message, "changes");
                    batch += changes.len();
                    received.extend(changes.iter().map(|change| text(change, "documentId")));
                }
                Event::Message(_) => {}
                Event::Closed(close) => panic!("the feed closes with {close:?} mid-window"),
            }
        }
        assert!(
            batch > 0,
            "{} sends changes once acknowledged",
            target.label()
        );
        batches.push(batch);
        send_value(&mut socket, &ack(&[scanned])).await;
    }
    let written: Vec<String> = (0..count).map(|at| format!("w{at:03}")).collect();
    assert_eq!(received, written, "{}", target.label());
    batches
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn change_feed_holds_changes_past_the_window_until_the_subscriber_acknowledges() {
    let setup = Setup {
        window_bytes: Some(1_024),
        ..Setup::new()
    };
    let (rust, reference) = pair(setup, false).await;
    let mine = windowed_delivery(&Target::Rust(&rust), 40).await;
    let theirs = windowed_delivery(&Target::Reference(&reference), 40).await;
    assert!(mine.len() > 1, "the window splits 40 changes: {mine:?}");
    assert_eq!(mine, theirs);
    rust.server.shutdown().await.expect("the server shuts down");
    reference.stop().await;
}

async fn index_changes(target: &Target<'_>) -> Vec<Outcome> {
    let mut outcomes = Vec::new();
    let (mut socket, _) = subscribed_socket(target, Some(tag_is("keep"))).await;
    let (mut unfiltered, _) = subscribed_socket(target, None).await;
    target.set_changes(true, false).await;
    let (messages, close) = until_closed(&mut socket).await;
    outcomes.push(outcome_of(&messages, close));
    let quiet = quiet_for(&mut unfiltered, QUIET).await;
    outcomes.push((vec![format!("{quiet:?}")], None));
    target.clear().await;
    let (messages, close) = until_closed(&mut unfiltered).await;
    outcomes.push(outcome_of(&messages, close));
    let (mut socket, _) = subscribed_socket(target, None).await;
    target.set_changes(false, false).await;
    let (messages, close) = until_closed(&mut socket).await;
    outcomes.push(outcome_of(&messages, close));
    target.set_changes(true, false).await;
    let (mut socket, _) = subscribed_socket(target, None).await;
    target.drop_index().await;
    let (messages, close) = until_closed(&mut socket).await;
    outcomes.push(outcome_of(&messages, close));
    outcomes
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn change_feed_follows_settings_epochs_and_a_dropped_index() {
    let (rust, reference) = pair(Setup::new(), true).await;
    let mine = index_changes(&Target::Rust(&rust)).await;
    let theirs = index_changes(&Target::Reference(&reference)).await;
    assert_eq!(mine, theirs);
    assert_eq!(
        mine.first().map(|outcome| outcome.1.clone()),
        Some(Some((
            4409,
            "CHANGES_PREVIOUS_DOCUMENT_REQUIRED".to_string()
        )))
    );
    assert_eq!(
        mine.last().map(|outcome| outcome.1.clone()),
        Some(Some((4410, "change capture is off".to_string())))
    );
    rust.server.shutdown().await.expect("the server shuts down");
    reference.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn closing_the_server_closes_every_change_feed() {
    let rust = RustFeeds::start(Setup::new()).await;
    let target = Target::Rust(&rust);
    target.create_index(INDEX).await;
    target.set_changes(true, false).await;
    let mut sockets = Vec::new();
    for _ in 0..8 {
        sockets.push(subscribed_socket(&target, None).await.0);
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
