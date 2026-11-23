use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use narsil::{Map, Value, decode_msgpack, encode_msgpack};
use narsil_cluster::coordinator::etcd::EtcdCoordinator;
use narsil_cluster::message::{TransportMessage, message_types};
use narsil_cluster::transport::NodeTransport;

use crate::data_node::{
    DataNode, Scratch, coordinator_at, etcd_endpoint, eventually, unique_key_prefix,
};
use crate::ledger::forwarder;
use crate::typescript_node::{TypescriptNode, fields, title_document};

const SURVEY: &str = "botanical-survey";
const FIRST_PARTITION_COUNT: u64 = 3;
const CHANGED_PARTITION_COUNT: f64 = 7.0;
const SEEDED_PLOTS: usize = 200;
const WRITER_KEYS: usize = 150;
const LIST_PAGE: u64 = 200;
const HEARTBEAT_TTL_SECONDS: u64 = 30;
const ROUTER: &str = "survey-router";
const RUST_CONTROLLER: &str = "survey-controller";
const WRITER: &str = "survey-writer";
const STATIONS: [&str; 3] = ["survey-station-a", "survey-station-b", "survey-station-c"];
const REFUSED_BEFORE_THE_WRITE: [&str; 2] = [
    "PARTITION_REBALANCING_BACKPRESSURE",
    "PARTITION_NOT_PRIMARY",
];
const REFUSAL_PAUSE: Duration = Duration::from_millis(5);
const LEDGER: &str = "ledger";
const LEDGER_STATION: &str = "ledger-station";
const TYPESCRIPT_LEDGER_STATION: &str = "ledger-typescript-station";
const LEDGER_PARTITIONS: u64 = 4;
const LEDGER_ENTRIES: usize = 40;

fn plot_title(sequence: usize) -> String {
    format!("meadow plot {sequence} with sedge")
}

struct Written {
    writes: usize,
    refusals: usize,
}

async fn write_until_stopped(
    writer: &mut TypescriptNode,
    oracle: &mut BTreeMap<String, String>,
    stop: &AtomicBool,
) -> Written {
    let mut sequence = 0;
    let mut refusals = 0;
    while !stop.load(Ordering::Acquire) {
        let id = format!("plot-{}", sequence % WRITER_KEYS);
        let title = plot_title(SEEDED_PLOTS + sequence);
        let removes = sequence % 5 == 4 && oracle.contains_key(&id);
        let answer = if removes {
            writer.remove(SURVEY, &id).await
        } else if oracle.contains_key(&id) {
            writer.update(SURVEY, &id, &title).await
        } else {
            writer.insert(SURVEY, &id, &title).await
        };
        match answer.code() {
            None => {
                if removes {
                    oracle.remove(&id);
                } else {
                    oracle.insert(id, title);
                }
                sequence += 1;
            }
            Some(code) => {
                assert!(
                    REFUSED_BEFORE_THE_WRITE.contains(&code),
                    "the writer met {code} on {id}"
                );
                refusals += 1;
                tokio::time::sleep(REFUSAL_PAUSE).await;
            }
        }
    }
    Written {
        writes: sequence,
        refusals,
    }
}

async fn listed_ids(router: &mut TypescriptNode) -> Vec<String> {
    let mut listed = Vec::new();
    let mut cursor = Value::Null;
    loop {
        let mut params = fields([
            ("limit", Value::from(LIST_PAGE)),
            ("document", Value::Bool(false)),
        ]);
        if !matches!(cursor, Value::Null) {
            params.insert("cursor", cursor.clone());
        }
        let Value::Object(page) = router
            .call(
                "listDocuments",
                fields([
                    ("indexName", Value::from(SURVEY)),
                    ("params", Value::Object(params)),
                ]),
            )
            .await
            .value()
        else {
            panic!("the router answers a listing page");
        };
        if let Some(Value::Array(ids)) = page.get("ids") {
            listed.extend(ids.iter().filter_map(Value::as_str).map(str::to_string));
        }
        cursor = page.get("cursor").cloned().unwrap_or(Value::Null);
        if matches!(cursor, Value::Null) {
            return listed;
        }
    }
}

async fn expect_matches_oracle(
    router: &mut TypescriptNode,
    oracle: &BTreeMap<String, String>,
    ever_written: &[String],
) {
    let counts = router.partition_counts(SURVEY).await;
    assert_eq!(counts.len(), CHANGED_PARTITION_COUNT as usize, "{counts:?}");
    assert_eq!(
        counts.iter().map(|(_, count)| *count).sum::<u64>(),
        oracle.len() as u64,
        "{counts:?}"
    );
    for id in ever_written {
        let held = router.title(SURVEY, id).await;
        assert_eq!(held.as_ref(), oracle.get(id), "the copy of {id}");
    }
    assert_eq!(router.title(SURVEY, "plot-never-written").await, None);
    let mut listed = listed_ids(router).await;
    listed.sort();
    assert_eq!(listed, oracle.keys().cloned().collect::<Vec<_>>());
}

async fn seeded_survey(router: &mut TypescriptNode) -> BTreeMap<String, String> {
    router.create_index(SURVEY, FIRST_PARTITION_COUNT, 1).await;
    let mut oracle = BTreeMap::new();
    for sequence in 0..SEEDED_PLOTS {
        let id = format!("plot-{sequence}");
        let title = plot_title(sequence);
        assert_eq!(router.insert(SURVEY, &id, &title).await.code(), None);
        oracle.insert(id, title);
    }
    oracle
}

async fn start_stations(coordinator: &Arc<EtcdCoordinator>, scratch: &[Scratch]) -> Vec<DataNode> {
    let mut stations = Vec::with_capacity(STATIONS.len());
    for (station, directory) in STATIONS.iter().zip(scratch) {
        stations.push(DataNode::start(coordinator, station, directory.path()).await);
    }
    stations
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ControllerProcess {
    Typescript,
    Rust,
}

#[tokio::test(flavor = "multi_thread")]
async fn rust_data_nodes_keep_every_acknowledged_write_while_a_typescript_controller_changes_the_count()
 {
    change_the_count_under_writers(ControllerProcess::Typescript).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn rust_data_nodes_keep_every_acknowledged_write_while_a_rust_controller_changes_the_count() {
    change_the_count_under_writers(ControllerProcess::Rust).await;
}

async fn change_the_count_under_writers(controller_process: ControllerProcess) {
    let Some(endpoint) = etcd_endpoint() else {
        return;
    };
    let key_prefix = unique_key_prefix();
    let coordinator =
        coordinator_at(endpoint.clone(), key_prefix.clone(), HEARTBEAT_TTL_SECONDS).await;
    let controller_scratch = Scratch::new();
    let (router_roles, rust_controller) = match controller_process {
        ControllerProcess::Typescript => ("controller,coordinator", None),
        ControllerProcess::Rust => (
            "coordinator",
            Some(
                DataNode::start_with_roles(
                    &coordinator,
                    RUST_CONTROLLER,
                    controller_scratch.path(),
                    &["controller"],
                )
                .await,
            ),
        ),
    };
    let mut router = TypescriptNode::start(&endpoint, &key_prefix, ROUTER, router_roles).await;
    let scratch: Vec<Scratch> = STATIONS.iter().map(|_| Scratch::new()).collect();
    let stations = start_stations(&coordinator, &scratch).await;
    let mut writer = TypescriptNode::start(&endpoint, &key_prefix, WRITER, "coordinator").await;
    let mut oracle = seeded_survey(&mut router).await;

    let stop = AtomicBool::new(false);
    let changing = async {
        let changed = router
            .call(
                "rebalance",
                fields([
                    ("indexName", Value::from(SURVEY)),
                    ("targetPartitionCount", Value::from(CHANGED_PARTITION_COUNT)),
                ]),
            )
            .await;
        stop.store(true, Ordering::Release);
        changed
    };
    let (changed, written) = tokio::join!(
        changing,
        write_until_stopped(&mut writer, &mut oracle, &stop)
    );
    assert_eq!(changed.code(), None, "{changed:?}");
    assert!(written.writes > 0, "{} refusals", written.refusals);

    let ever_written: Vec<String> = (0..SEEDED_PLOTS.max(WRITER_KEYS))
        .map(|sequence| format!("plot-{sequence}"))
        .collect();
    expect_matches_oracle(&mut router, &oracle, &ever_written).await;
    expect_matches_oracle(&mut writer, &oracle, &ever_written).await;

    writer.shutdown().await;
    for station in stations {
        station.stop().await;
    }
    router.shutdown().await;
    if let Some(controller) = rust_controller {
        controller.stop().await;
    }
    coordinator.shutdown().await;
}

fn forward_without_job() -> Vec<u8> {
    let operation = |document_id: &str, title: &str| {
        Value::Object(fields([
            ("documentId", Value::from(document_id)),
            ("operation", Value::from("replace")),
            (
                "document",
                Value::Bytes(encode_msgpack(&title_document(title)).expect("a title encodes")),
            ),
        ]))
    };
    let payload = Value::Object(fields([
        ("targetGeneration", Value::from(LEDGER)),
        ("jobId", Value::from("job-that-never-ran")),
        ("sourcePartitionId", Value::from(0u64)),
        ("sourcePrimaryTerm", Value::from(1u64)),
        (
            "operations",
            Value::Array(vec![
                operation("entry-1", "overwritten"),
                operation("entry-2", "planted"),
            ]),
        ),
    ]));
    encode_msgpack(&payload).expect("the forward encodes")
}

fn assert_refused_with_allocation_failed(reply: &TransportMessage) {
    let Ok(Value::Object(body)) = decode_msgpack(&reply.payload) else {
        panic!("the primary answers with a MessagePack map");
    };
    let expected: Map = fields([
        ("error", Value::Bool(true)),
        ("code", Value::from("ALLOCATION_FAILED")),
    ]);
    for (key, value) in expected.iter() {
        assert_eq!(body.get(key), Some(value), "{body:?}");
    }
}

fn purge_of_a_public_index() -> Vec<u8> {
    let payload = Value::Object(fields([
        ("targetGeneration", Value::from(LEDGER)),
        ("jobId", Value::from("job-that-never-ran")),
        ("sourcePartitionCount", Value::from(1u64)),
        ("sourcePartitionId", Value::from(0u64)),
    ]));
    encode_msgpack(&payload).expect("the purge encodes")
}

async fn ledger_primaries(coordinator: &EtcdCoordinator) -> BTreeSet<String> {
    coordinator
        .allocation(LEDGER)
        .await
        .expect("etcd answers for the table")
        .map(|table| {
            table
                .assignments
                .iter()
                .filter_map(|(_, assignment)| {
                    assignment
                        .get("primary")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rust_and_a_typescript_primary_keep_every_document_when_a_purge_names_a_public_index() {
    let Some(endpoint) = etcd_endpoint() else {
        return;
    };
    let key_prefix = unique_key_prefix();
    let coordinator =
        coordinator_at(endpoint.clone(), key_prefix.clone(), HEARTBEAT_TTL_SECONDS).await;
    let mut router =
        TypescriptNode::start(&endpoint, &key_prefix, ROUTER, "controller,coordinator").await;
    let scratch = Scratch::new();
    let station = DataNode::start(&coordinator, LEDGER_STATION, scratch.path()).await;
    let typescript_station =
        TypescriptNode::start(&endpoint, &key_prefix, TYPESCRIPT_LEDGER_STATION, "data").await;
    router.create_index(LEDGER, LEDGER_PARTITIONS, 0).await;
    let both: BTreeSet<String> = [LEDGER_STATION, TYPESCRIPT_LEDGER_STATION]
        .map(str::to_string)
        .into();
    eventually("both stations lead a partition of the ledger", || async {
        ledger_primaries(&coordinator).await == both
    })
    .await;
    let entries: Vec<String> = (0..LEDGER_ENTRIES)
        .map(|sequence| format!("entry-{sequence}"))
        .collect();
    for id in &entries {
        assert_eq!(
            router
                .insert(LEDGER, id, &format!("balance {id}"))
                .await
                .code(),
            None
        );
    }

    let peer = forwarder();
    for address in [&station.address, &typescript_station.address] {
        let reply = peer
            .send(
                address,
                TransportMessage::new(
                    message_types::CLUSTER_RESHARD_PURGE,
                    "ledger-forwarder",
                    "purge-of-a-public-index",
                    purge_of_a_public_index(),
                ),
            )
            .await
            .expect("the primary answers the purge");
        assert_refused_with_allocation_failed(&reply);
    }
    for id in &entries {
        assert_eq!(
            router.title(LEDGER, id).await,
            Some(format!("balance {id}")),
            "the copy of {id}"
        );
    }
    let counts = router.partition_counts(LEDGER).await;
    assert_eq!(
        counts.iter().map(|(_, count)| *count).sum::<u64>(),
        LEDGER_ENTRIES as u64,
        "{counts:?}"
    );

    peer.shutdown().await;
    typescript_station.shutdown().await;
    station.stop().await;
    router.shutdown().await;
    coordinator.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rust_primary_refuses_a_reshard_forward_that_no_partition_count_change_sends() {
    let Some(endpoint) = etcd_endpoint() else {
        return;
    };
    let key_prefix = unique_key_prefix();
    let coordinator =
        coordinator_at(endpoint.clone(), key_prefix.clone(), HEARTBEAT_TTL_SECONDS).await;
    let mut router =
        TypescriptNode::start(&endpoint, &key_prefix, ROUTER, "controller,coordinator").await;
    let scratch = Scratch::new();
    let station = DataNode::start(&coordinator, LEDGER_STATION, scratch.path()).await;
    router.create_index(LEDGER, 1, 0).await;
    assert_eq!(
        router
            .insert(LEDGER, "entry-1", "opening balance")
            .await
            .code(),
        None
    );

    let peer = forwarder();
    let reply = peer
        .send(
            &station.address,
            TransportMessage::new(
                message_types::CLUSTER_RESHARD_FORWARD,
                "ledger-forwarder",
                "forward-without-job",
                forward_without_job(),
            ),
        )
        .await
        .expect("the station answers the forward");
    assert_refused_with_allocation_failed(&reply);
    assert_eq!(
        router.title(LEDGER, "entry-1").await.as_deref(),
        Some("opening balance")
    );
    assert_eq!(router.title(LEDGER, "entry-2").await, None);
    let counts = router.partition_counts(LEDGER).await;
    assert_eq!(
        counts.iter().map(|(_, count)| *count).sum::<u64>(),
        1,
        "{counts:?}"
    );

    peer.shutdown().await;
    station.stop().await;
    router.shutdown().await;
    coordinator.shutdown().await;
}
