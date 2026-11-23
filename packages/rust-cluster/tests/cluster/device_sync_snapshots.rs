use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use narsil::{
    ChangePosition, ChangesEvent, ChangesRequest, ChangesSetting, FilesystemPersistence,
    ListParams, Map, Narsil, NarsilConfig, SyncSetting, Value, parse_json,
};
use narsil_cluster::coordinator::etcd::EtcdCoordinator;
use narsil_cluster::node::{ClusterBackupConfig, ClusterSyncSnapshot};

use crate::data_node::{DataNode, Scratch, cluster_coordinator, create_cluster_index, eventually};

const HARBOUR: &str = "harbour";
const HARBOUR_UUID: &str = "uuid-of-the-harbour-index";
const PARTITIONS: u64 = 2;
const REPLICATION_FACTOR: u64 = 1;
const FIRST_DOCUMENTS: usize = 200;
const LATER_DOCUMENTS: usize = 40;
const REMOVED_DOCUMENTS: usize = 25;
const STORE_KEY_PREFIX: &str = "clusters/harbour";
const CONTROLLER: &str = "snapshot-controller";
const DATA_NODES: [&str; 2] = ["snapshot-data-a", "snapshot-data-b"];
const READ_CHUNK_BYTES: usize = 65_536;
const LISTED_AT_ONCE: usize = 10_000;
const SNAPSHOT_RETRY_AFTER_MS: f64 = 5_000.0;
const BACKUP_WAIT: Duration = Duration::from_secs(60);
const BACKUP_POLL: Duration = Duration::from_millis(200);
const CHANGE_WAIT: Duration = Duration::from_millis(500);
const CATCH_UP_WAIT: Duration = Duration::from_secs(30);

type Titles = BTreeMap<String, String>;

fn note(at: usize) -> Map {
    let mut document = Map::new();
    document.insert("id", Value::from(format!("n{at}")));
    document.insert("title", Value::from(format!("harbour note {at}")));
    document
}

fn title_of(document: &Map) -> String {
    document
        .get("title")
        .and_then(Value::as_str)
        .expect("every note has a title")
        .to_string()
}

async fn start_node(
    coordinator: &Arc<EtcdCoordinator>,
    node_id: &str,
    directory: &Path,
    store: &Path,
    roles: &[&str],
) -> DataNode {
    let store = store.to_path_buf();
    DataNode::start_configured(coordinator, node_id, directory, roles, |config| {
        config.backups = Some(ClusterBackupConfig {
            store: Arc::new(
                FilesystemPersistence::new(&store).expect("the store directory is valid"),
            ),
            key_prefix: STORE_KEY_PREFIX.to_string(),
        });
    })
    .await
}

async fn all_active(coordinator: &EtcdCoordinator) -> bool {
    let Some(table) = coordinator
        .allocation(HARBOUR)
        .await
        .expect("etcd answers for the table")
    else {
        return false;
    };
    table.assignments.len() == PARTITIONS as usize
        && table.assignments.iter().all(|(_, assignment)| {
            assignment.get("state").and_then(Value::as_str) == Some("ACTIVE")
        })
}

fn whole_archive(snapshot: &ClusterSyncSnapshot, from: u64) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut offset = from;
    let mut buffer = vec![0u8; READ_CHUNK_BYTES];
    while offset < snapshot.byte_length() {
        let read = snapshot
            .read_at(offset, &mut buffer)
            .expect("the spooled snapshot reads");
        assert!(read > 0, "the snapshot ended before its listed length");
        bytes.extend_from_slice(&buffer[..read]);
        offset += read as u64;
    }
    bytes
}

fn titles_on_device(archive: &[u8]) -> Titles {
    let device = Narsil::open(NarsilConfig::default()).expect("a device engine opens");
    device
        .restore(HARBOUR, &mut &archive[..])
        .expect("the device restores the cluster's snapshot");
    let params = ListParams {
        limit: Some(LISTED_AT_ONCE),
        ..ListParams::default()
    };
    let listed = device
        .list_documents(HARBOUR, &params)
        .expect("the device lists its copy");
    assert!(
        listed.cursor.is_none(),
        "the device holds more notes than one page"
    );
    listed
        .documents
        .iter()
        .map(|listed| (listed.id.clone(), title_of(&listed.document)))
        .collect()
}

async fn ready_snapshot(node: &DataNode) -> ClusterSyncSnapshot {
    let deadline = Instant::now() + BACKUP_WAIT;
    loop {
        match node.node.sync_snapshot(HARBOUR).await {
            Ok(snapshot) => return snapshot,
            Err(error) if error.code() == "SYNC_SNAPSHOT_PREPARING" => {}
            Err(error) => panic!("the snapshot fails: {error:?}"),
        }
        assert!(
            Instant::now() < deadline,
            "no backup qualified for the snapshot"
        );
        tokio::time::sleep(BACKUP_POLL).await;
    }
}

struct Export {
    epoch: String,
    positions: Vec<ChangePosition>,
    titles: Titles,
}

fn read_export(bytes: &[u8]) -> Export {
    let text = std::str::from_utf8(bytes).expect("an export is UTF-8");
    let mut lines = text.lines();
    let Some(Ok(Value::Object(header))) = lines.next().map(parse_json) else {
        panic!("the export opens with its header");
    };
    let epoch = header
        .get("epoch")
        .and_then(Value::as_str)
        .expect("the header holds the epoch")
        .to_string();
    let Some(Value::Array(listed)) = header.get("positions") else {
        panic!("the header lists the positions");
    };
    let positions = listed
        .iter()
        .map(|position| {
            let Value::Object(position) = position else {
                panic!("a position is an object");
            };
            let number = |key: &str| {
                position
                    .get(key)
                    .and_then(Value::as_f64)
                    .expect("a position holds numbers")
            };
            ChangePosition {
                partition_id: number("partitionId") as u32,
                seq_no: number("seqNo") as u64,
            }
        })
        .collect();
    let titles = lines
        .map(|line| {
            let Ok(Value::Object(document)) = parse_json(line) else {
                panic!("a document line is an object");
            };
            let id = document
                .get("id")
                .and_then(Value::as_str)
                .expect("a line holds its id");
            (id.to_string(), title_of(&document))
        })
        .collect();
    Export {
        epoch,
        positions,
        titles,
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rust_cluster_serves_a_device_snapshot_and_a_document_export_that_hold_every_acknowledged_write()
 {
    let Some(coordinator) = cluster_coordinator().await else {
        return;
    };
    let store = Scratch::new();
    let scratches = [Scratch::new(), Scratch::new(), Scratch::new()];
    let controller = start_node(
        &coordinator,
        CONTROLLER,
        scratches[0].path(),
        store.path(),
        &["controller"],
    )
    .await;
    let first = start_node(
        &coordinator,
        DATA_NODES[0],
        scratches[1].path(),
        store.path(),
        &["data"],
    )
    .await;
    let second = start_node(
        &coordinator,
        DATA_NODES[1],
        scratches[2].path(),
        store.path(),
        &["data"],
    )
    .await;
    create_cluster_index(
        &coordinator,
        HARBOUR,
        HARBOUR_UUID,
        PARTITIONS,
        REPLICATION_FACTOR,
    )
    .await;
    eventually("every partition of the harbour index is active", || {
        all_active(&coordinator)
    })
    .await;

    let mut oracle = Titles::new();
    let notes: Vec<Map> = (0..FIRST_DOCUMENTS).map(note).collect();
    for (at, document) in notes.iter().enumerate() {
        oracle.insert(format!("n{at}"), title_of(document));
    }
    let written = first
        .node
        .insert_batch(HARBOUR, notes)
        .await
        .expect("the cluster takes the notes");
    assert!(written.failed.is_empty(), "every note is acknowledged");

    let enabled = SyncSetting {
        enabled: true,
        ..SyncSetting::default()
    };
    first
        .node
        .update_sync(HARBOUR, &enabled)
        .await
        .expect("sync goes on");
    assert!(
        !first
            .node
            .get_sync(HARBOUR)
            .await
            .expect("sync reads")
            .active
    );
    let Err(preparing) = first.node.sync_snapshot(HARBOUR).await else {
        panic!("the first snapshot waits on a backup");
    };
    assert_eq!(preparing.code(), "SYNC_SNAPSHOT_PREPARING");
    assert_eq!(
        preparing
            .details()
            .get("retryAfterMs")
            .and_then(Value::as_f64),
        Some(SNAPSHOT_RETRY_AFTER_MS)
    );
    assert!(
        first
            .node
            .get_sync(HARBOUR)
            .await
            .expect("sync reads")
            .active
    );

    let snapshot = ready_snapshot(&first).await;
    let whole = whole_archive(&snapshot, 0);
    let elsewhere = ready_snapshot(&second).await;
    assert_eq!(elsewhere.entity_tag(), snapshot.entity_tag());
    let cut = (whole.len() / 2) as u64;
    let mut resumed = whole[..cut as usize].to_vec();
    resumed.extend(whole_archive(&elsewhere, cut));
    assert_eq!(
        resumed, whole,
        "a download resumed on another node gives the same bytes"
    );
    assert_eq!(titles_on_device(&whole), oracle);

    let capture = ChangesSetting {
        enabled: true,
        ..ChangesSetting::default()
    };
    first
        .node
        .update_changes(HARBOUR, &capture)
        .await
        .expect("change capture goes on");
    let export = loop {
        match second.node.export_documents(HARBOUR).await {
            Ok(export) => break export,
            Err(error) if error.code() == "CHANGES_EXPORT_PREPARING" => {
                tokio::time::sleep(BACKUP_POLL).await;
            }
            Err(error) => panic!("the export fails: {error:?}"),
        }
    };
    let mut bytes = Vec::new();
    export.write_to(&mut bytes).expect("the export writes");
    let exported = read_export(&bytes);
    assert_eq!(exported.titles, oracle);

    for at in FIRST_DOCUMENTS..FIRST_DOCUMENTS + LATER_DOCUMENTS {
        let document = note(at);
        oracle.insert(format!("n{at}"), title_of(&document));
        first
            .node
            .insert(HARBOUR, document, None)
            .await
            .expect("the cluster takes a later note");
    }
    for at in 0..REMOVED_DOCUMENTS {
        oracle.remove(&format!("n{at}"));
        first
            .node
            .remove(HARBOUR, &format!("n{at}"))
            .await
            .expect("the cluster removes a note");
    }

    let request = ChangesRequest {
        epoch: Some(exported.epoch.clone()),
        positions: Some(exported.positions.clone()),
        filter: None,
    };
    let mut feed = second
        .node
        .follow_changes(HARBOUR, &request)
        .await
        .expect("the change feed opens at the export's positions");
    let mut copy = exported.titles;
    let deadline = Instant::now() + CATCH_UP_WAIT;
    while copy != oracle {
        assert!(
            Instant::now() < deadline,
            "the change feed never caught the copy up"
        );
        let next = tokio::task::block_in_place(|| feed.next_within(CHANGE_WAIT));
        match next {
            None => {}
            Some(Ok(ChangesEvent::Subscribed(_))) => {}
            Some(Ok(ChangesEvent::Changes(group))) => {
                for change in group.changes {
                    match change.document {
                        Some(document) => {
                            copy.insert(change.document_id, title_of(&document));
                        }
                        None => {
                            copy.remove(&change.document_id);
                        }
                    }
                }
            }
            Some(Ok(ChangesEvent::Resync(reason))) => {
                panic!("the feed asked for a resync: {reason:?}")
            }
            Some(Err(error)) => panic!("the change feed fails: {error:?}"),
        }
    }
    feed.stop();

    second.stop().await;
    first.stop().await;
    controller.stop().await;
}
