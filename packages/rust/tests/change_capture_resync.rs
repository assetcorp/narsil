mod support;

use std::time::{Duration, Instant};

use narsil::{
    ChangePosition, ChangeType, ChangesEvent, ChangesRequest, ChangesSetting, ErrorCode,
    FieldTests, Filter, Narsil, QueryParams, ResyncReason, SyncSetting, Value,
};
use support::ScratchDirectory;
use support::changes::{
    FEED_WAIT, INDEX, Oracle, Subscriber, capture, first_event, heads_of, history_files,
    open_orders, order, resync_of,
};

const RETENTION_WAIT: Duration = Duration::from_secs(60);
const SAFE_INTEGER_LIMIT: u64 = 9_007_199_254_740_991;

fn insert_orders(narsil: &Narsil, oracle: &mut Oracle, prefix: &str, count: usize) {
    for at in 0..count {
        let id = format!("{prefix}{at}");
        oracle.insert(
            narsil,
            &id,
            order(&format!("order {id}"), "open", at as f64),
        );
    }
}

fn next_event(feed: &mut narsil::ChangeFeed) -> Option<narsil::Result<ChangesEvent>> {
    let started = Instant::now();
    while started.elapsed() < FEED_WAIT {
        if let Some(event) = feed.next_within(Duration::from_millis(200)) {
            return Some(event);
        }
        if feed.is_finished() {
            return None;
        }
    }
    panic!("the feed returned nothing in time");
}

fn drain(feed: &mut narsil::ChangeFeed) -> (Vec<String>, narsil::Result<ResyncReason>) {
    let mut delivered = Vec::new();
    loop {
        match next_event(feed) {
            Some(Ok(ChangesEvent::Changes(group))) => {
                delivered.extend(group.changes.into_iter().map(|change| change.document_id));
            }
            Some(Ok(ChangesEvent::Subscribed(_))) => {}
            Some(Ok(ChangesEvent::Resync(reason))) => return (delivered, Ok(reason)),
            Some(Err(error)) => return (delivered, Err(error)),
            None => panic!("the feed ended without a reason"),
        }
    }
}

#[test]
fn every_rewrite_of_the_index_ends_an_open_feed_before_it_delivers_a_later_write() {
    let scratch = ScratchDirectory::new("changes-epochs");
    let root = scratch.path().join("data");
    let narsil = open_orders(&root, 2, &capture(true));
    let mut oracle = Oracle::default();
    insert_orders(&narsil, &mut oracle, "kept", 30);
    let mut archive = Vec::new();
    narsil
        .snapshot(INDEX, &mut archive)
        .expect("the archive writes");
    for name in ["clear", "restore", "rebalance"] {
        let before = Subscriber::from_export(&narsil, false);
        insert_orders(&narsil, &mut oracle, &format!("{name}-before-"), 200);
        let mut feed = narsil
            .changes(INDEX, &before.request())
            .expect("the feed opens");
        match name {
            "clear" => narsil.clear(INDEX).expect("the clear applies"),
            "restore" => narsil
                .restore(INDEX, &mut archive.as_slice())
                .expect("the restore applies"),
            _ => narsil.rebalance(INDEX, 3).expect("the rebalance applies"),
        }
        insert_orders(&narsil, &mut oracle, &format!("{name}-after-"), 20);
        let (delivered, ended) = drain(&mut feed);
        assert_eq!(
            ended.expect("the feed ends with a resync"),
            ResyncReason::Epoch,
            "{name}"
        );
        let late = format!("{name}-after-");
        assert!(
            delivered.iter().all(|id| !id.starts_with(&late)),
            "a feed of the old epoch delivers no write after the {name}"
        );
        assert_eq!(
            resync_of(&narsil, &before.request()),
            ResyncReason::Epoch,
            "positions of the old epoch resync after the {name}"
        );
        let after = Subscriber::from_export(&narsil, false);
        assert_ne!(
            after.epoch, before.epoch,
            "the {name} gives the index a new epoch"
        );
    }
}

#[test]
fn turning_capture_off_ends_every_feed_and_deletes_the_history() {
    let scratch = ScratchDirectory::new("changes-off");
    let root = scratch.path().join("data");
    let narsil = open_orders(&root, 1, &capture(true));
    let mut oracle = Oracle::default();
    insert_orders(&narsil, &mut oracle, "h", 120);
    oracle.remove(&narsil, "h3");
    narsil.checkpoint(INDEX).expect("the checkpoint applies");
    assert!(
        !history_files(&root).is_empty(),
        "a checkpoint moves covered segments into history"
    );
    let mut filtered = narsil
        .changes(
            INDEX,
            &ChangesRequest {
                filter: Some(Filter::field("status", FieldTests::new().eq("open"))),
                ..ChangesRequest::default()
            },
        )
        .expect("the filtered feed opens");
    let mut plain = narsil
        .changes(INDEX, &ChangesRequest::default())
        .expect("the feed opens");
    narsil
        .update_changes(INDEX, &capture(false))
        .expect("previous documents turn off");
    let (_, ended) = drain(&mut filtered);
    assert_eq!(
        ended.expect_err("the filtered feed fails").code(),
        ErrorCode::CHANGES_PREVIOUS_DOCUMENT_REQUIRED
    );
    narsil
        .update_changes(INDEX, &ChangesSetting::default())
        .expect("capture turns off");
    let (_, ended) = drain(&mut plain);
    assert_eq!(
        ended.expect_err("the feed fails").code(),
        ErrorCode::CHANGES_NOT_ENABLED
    );
    assert!(
        history_files(&root).is_empty(),
        "turning capture off deletes the history"
    );
    let status = narsil
        .get_changes_setting(INDEX)
        .expect("the setting reads");
    assert!(!status.enabled && status.epoch.is_none());
    let refused = narsil.changes(INDEX, &ChangesRequest::default()).err();
    assert_eq!(
        refused.map(|error| error.code()),
        Some(ErrorCode::CHANGES_NOT_ENABLED)
    );
}

fn refusal(narsil: &Narsil, request: &ChangesRequest) -> ErrorCode {
    match narsil.changes(INDEX, request) {
        Ok(_) => panic!("the request opens a feed: {request:?}"),
        Err(error) => error.code(),
    }
}

fn positions(pairs: &[(u32, u64)]) -> Option<Vec<ChangePosition>> {
    Some(
        pairs
            .iter()
            .map(|(partition_id, seq_no)| ChangePosition {
                partition_id: *partition_id,
                seq_no: *seq_no,
            })
            .collect(),
    )
}

#[test]
fn malformed_requests_and_settings_fail_with_their_codes() {
    let memory = Narsil::new();
    memory
        .create_index(INDEX, support::changes::order_index())
        .expect("the index is created");
    let refused = memory
        .update_changes(INDEX, &capture(false))
        .expect_err("memory refuses capture");
    assert_eq!(refused.code(), ErrorCode::CHANGES_DURABILITY_REQUIRED);
    assert_eq!(
        memory
            .changes(INDEX, &ChangesRequest::default())
            .err()
            .map(|error| error.code()),
        Some(ErrorCode::CHANGES_NOT_ENABLED)
    );

    let scratch = ScratchDirectory::new("changes-malformed");
    let root = scratch.path().join("data");
    let narsil = open_orders(&root, 2, &capture(false));
    for (age, bytes) in [
        (Some(0), None),
        (None, Some(0)),
        (Some(SAFE_INTEGER_LIMIT + 1), None),
    ] {
        let setting = ChangesSetting {
            history_max_age_ms: age,
            history_max_bytes: bytes,
            ..capture(true)
        };
        let refused = narsil
            .update_changes(INDEX, &setting)
            .expect_err("a bad limit fails");
        assert_eq!(refused.code(), ErrorCode::CONFIG_INVALID);
    }
    assert!(
        !narsil
            .get_changes_setting(INDEX)
            .expect("the setting reads")
            .previous_document
    );
    let refused = narsil
        .update_changes("absent", &capture(true))
        .expect_err("no such index");
    assert_eq!(refused.code(), ErrorCode::INDEX_NOT_FOUND);

    let mut oracle = Oracle::default();
    insert_orders(&narsil, &mut oracle, "m", 20);
    let epoch = narsil
        .get_changes_setting(INDEX)
        .expect("the setting reads")
        .epoch
        .expect("an epoch");
    let heads = heads_of(&narsil);
    let at = |partition_id: u32| heads.get(&partition_id).copied().unwrap_or(0);
    let with = |epoch: Option<&str>, listed: Option<Vec<ChangePosition>>| ChangesRequest {
        epoch: epoch.map(str::to_string),
        positions: listed,
        filter: None,
    };
    let invalid = [
        with(Some(&epoch), None),
        with(None, positions(&[(0, 0), (1, 0)])),
        with(
            Some("ABCDEF00ABCDEF00ABCDEF00ABCDEF00"),
            positions(&[(0, 0), (1, 0)]),
        ),
        with(Some("abc"), positions(&[(0, 0), (1, 0)])),
        with(Some(&epoch), positions(&[(0, 0)])),
        with(Some(&epoch), positions(&[(0, 0), (0, 0)])),
        with(Some(&epoch), positions(&[(0, 0), (1, 0), (2, 0)])),
        with(Some(&epoch), positions(&[(0, 0), (7, 0)])),
    ];
    for request in &invalid {
        assert_eq!(
            refusal(&narsil, request),
            ErrorCode::CHANGES_INVALID_POSITIONS,
            "{request:?}"
        );
    }
    let filtered = ChangesRequest {
        filter: Some(Filter::field("status", FieldTests::new().eq("open"))),
        ..ChangesRequest::default()
    };
    assert_eq!(
        refusal(&narsil, &filtered),
        ErrorCode::CHANGES_PREVIOUS_DOCUMENT_REQUIRED
    );
    narsil
        .update_changes(INDEX, &capture(true))
        .expect("previous documents turn on");
    let mut too_deep = Filter::field("status", FieldTests::new().eq("open"));
    for _ in 0..64 {
        too_deep = Filter::negate(too_deep);
    }
    for broken in [
        Filter::field("absent", FieldTests::new().eq("open")),
        Filter::field("total", FieldTests::new().eq("not a number")),
        Filter::from_value(Value::String("status".into())),
        too_deep,
    ] {
        let query = QueryParams {
            filters: Some(broken.to_value()),
            ..QueryParams::default()
        };
        let query_code = narsil
            .query(INDEX, &query)
            .expect_err("the query refuses the filter")
            .code();
        assert!(
            matches!(
                query_code,
                ErrorCode::SEARCH_INVALID_FILTER | ErrorCode::SEARCH_INVALID_FIELD
            ),
            "{query_code:?}"
        );
        let request = ChangesRequest {
            filter: Some(broken),
            ..ChangesRequest::default()
        };
        assert_eq!(
            refusal(&narsil, &request),
            query_code,
            "a feed refuses a filter as a query does"
        );
    }
    let other_epoch = "0123456789abcdef0123456789abcdef";
    assert_eq!(
        resync_of(
            &narsil,
            &with(Some(other_epoch), positions(&[(0, 9_999), (1, 9_999)]))
        ),
        ResyncReason::Epoch,
        "the epoch decides before the positions"
    );
    assert_eq!(
        resync_of(
            &narsil,
            &with(Some(&epoch), positions(&[(0, at(0) + 50), (1, at(1))]))
        ),
        ResyncReason::Ahead
    );
    let mut feed = narsil
        .changes(
            INDEX,
            &with(Some(&epoch), positions(&[(1, at(1)), (0, at(0))])),
        )
        .expect("positions in any order open the feed");
    assert!(matches!(
        first_event(&mut feed),
        ChangesEvent::Subscribed(_)
    ));
}

fn wait_for_empty_history(root: &std::path::Path) {
    let started = Instant::now();
    while !history_files(root).is_empty() {
        assert!(
            started.elapsed() < RETENTION_WAIT,
            "the history limit deletes old segments"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn a_reader_behind_the_history_limit_resyncs_and_resumes_from_a_new_export_without_a_gap() {
    let scratch = ScratchDirectory::new("changes-history");
    let root = scratch.path().join("data");
    let tight = ChangesSetting {
        history_max_bytes: Some(1),
        ..capture(true)
    };
    let narsil = open_orders(&root, 2, &tight);
    let mut oracle = Oracle::default();
    insert_orders(&narsil, &mut oracle, "early", 50);
    let behind = Subscriber::from_export(&narsil, true);
    insert_orders(&narsil, &mut oracle, "later", 300);
    for at in 0..40 {
        oracle.update(
            &narsil,
            &format!("later{at}"),
            order("rewritten", "closed", at as f64),
        );
    }
    narsil.checkpoint(INDEX).expect("the checkpoint applies");
    wait_for_empty_history(&root);
    assert_eq!(resync_of(&narsil, &behind.request()), ResyncReason::History);

    let mut fresh = Subscriber::from_export(&narsil, true);
    assert_eq!(
        fresh.copy, oracle.documents,
        "the new export holds every document"
    );
    wait_for_empty_history(&root);
    for at in 40..80 {
        oracle.update(
            &narsil,
            &format!("later{at}"),
            order("rewritten again", "closed", at as f64),
        );
    }
    oracle.remove(&narsil, "early7");
    let mut feed = narsil
        .changes(INDEX, &fresh.request())
        .expect("the feed opens");
    fresh.follow_to(&mut feed, &heads_of(&narsil));
    assert_eq!(
        fresh.copy, oracle.documents,
        "the reader resumes from the export with no gap"
    );
}

#[test]
fn turning_device_sync_on_and_off_keeps_the_epoch_and_the_history_that_capture_reads() {
    let scratch = ScratchDirectory::new("changes-sync");
    let root = scratch.path().join("data");
    let narsil = open_orders(&root, 2, &capture(true));
    let mut oracle = Oracle::default();
    insert_orders(&narsil, &mut oracle, "s", 40);
    let mut subscriber = Subscriber::from_export(&narsil, true);
    insert_orders(&narsil, &mut oracle, "t", 200);
    for at in 0..20 {
        oracle.remove(&narsil, &format!("t{at}"));
    }
    narsil.checkpoint(INDEX).expect("the checkpoint applies");
    assert!(!history_files(&root).is_empty());
    let sync = |enabled: bool| SyncSetting {
        enabled,
        history_max_age_ms: None,
        history_max_bytes: None,
    };
    narsil
        .update_sync(INDEX, &sync(true))
        .expect("sync turns on");
    let status = narsil.get_sync(INDEX).expect("the sync state reads");
    assert_eq!(
        status.epoch.as_deref(),
        Some(subscriber.epoch.as_str()),
        "sync keeps capture's epoch"
    );
    narsil
        .update_sync(INDEX, &sync(false))
        .expect("sync turns off");
    let changes = narsil
        .get_changes_setting(INDEX)
        .expect("the setting reads");
    assert_eq!(changes.epoch.as_deref(), Some(subscriber.epoch.as_str()));
    let mut feed = narsil
        .changes(INDEX, &subscriber.request())
        .expect("the feed opens");
    subscriber.follow_to(&mut feed, &heads_of(&narsil));
    assert_eq!(
        subscriber.copy, oracle.documents,
        "the history survives sync turning off"
    );
    let removals = subscriber
        .applied
        .iter()
        .filter(|change| change.change_type == ChangeType::Remove)
        .count();
    assert_eq!(removals, 20);
}
