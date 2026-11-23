use narsil::{ChangesStatus, Map, SyncSetting, SyncStatus, Value, encode_msgpack};
use narsil_cluster::message::TransportMessage;
use narsil_cluster::transport::NodeTransport;
use narsil_cluster::transport::tcp::TcpTransport;

use crate::data_node::{
    DataNode, Scratch, cluster_coordinator, create_cluster_index, eventually, is_served_by,
    metadata_key,
};
use crate::ledger::{
    Forwarded, LEDGER, LEDGER_UUID, forward_insert, forwarder, start_controller, title_of,
};
use crate::support::{Decoded, decode};

const SYNC_READ: &str = "sync.read";
const SYNC_READ_REFUSED: &str = "sync.read.error";
const WRITTEN: [&str; 3] = ["sync-first", "sync-second", "sync-third"];
const ANOTHER_UUID: &str = "uuid-of-another-ledger";
const TYPESCRIPT_EPOCH: &str = "0123456789abcdef0123456789abcdef";

fn request(fields: &[(&str, Value)]) -> Vec<u8> {
    let map: Map = fields
        .iter()
        .map(|(key, value)| (*key, value.clone()))
        .collect();
    encode_msgpack(&Value::Object(map)).expect("the request encodes")
}

fn read_request(index_uuid: &str, partition_id: f64, after_seq_no: f64, max_bytes: f64) -> Vec<u8> {
    request(&[
        ("indexName", Value::from(LEDGER)),
        ("indexUuid", Value::from(index_uuid)),
        ("partitionId", Value::Number(partition_id)),
        ("afterSeqNo", Value::Number(after_seq_no)),
        ("maxBytes", Value::Number(max_bytes)),
    ])
}

async fn send(forwarder: &TcpTransport, address: &str, payload: Vec<u8>) -> (String, Decoded) {
    let message = TransportMessage::new(SYNC_READ, "sync-reader", "sync-read-request", payload);
    let answer = forwarder
        .send(address, message)
        .await
        .expect("the primary answers the read");
    (answer.message_type.clone(), decode(&answer.payload))
}

fn unsigned(decoded: &Decoded, name: &str) -> u64 {
    match decoded.field(name) {
        Some(Decoded::Unsigned(number)) => *number,
        Some(Decoded::Float(number)) if number.fract() == 0.0 && *number >= 0.0 => *number as u64,
        other => panic!("{name} holds {other:?}, which is not a sequence number"),
    }
}

fn entries(decoded: &Decoded) -> &[Decoded] {
    match decoded.field("entries") {
        Some(Decoded::List(entries)) => entries,
        other => panic!("the reply lists entries, not {other:?}"),
    }
}

fn title_in(entry: &Decoded) -> String {
    match entry.field("document") {
        Some(Decoded::Binary(document)) => decode(document).text("title"),
        Some(document @ Decoded::Fields(_)) => document.text("title"),
        other => panic!("an insert entry carries its document, not {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rust_primary_answers_sync_reads_with_its_committed_entries_and_the_codes_that_the_spec_gives()
 {
    let Some(coordinator) = cluster_coordinator().await else {
        return;
    };
    let controller_scratch = Scratch::new();
    let controller = start_controller(&coordinator, &controller_scratch).await;
    let primary_scratch = Scratch::new();
    let primary = DataNode::start(&coordinator, "sync-primary", primary_scratch.path()).await;
    create_cluster_index(&coordinator, LEDGER, LEDGER_UUID, 1, 0).await;
    eventually("the data node leads the ledger", || {
        is_served_by(&coordinator, LEDGER, LEDGER_UUID, 1, "sync-primary")
    })
    .await;
    let raw = forwarder();
    for document_id in WRITTEN {
        assert!(matches!(
            forward_insert(&raw, &primary.address, document_id).await,
            Forwarded::Acknowledged
        ));
    }

    let (message_type, reply) = send(
        &raw,
        &primary.address,
        read_request(LEDGER_UUID, 0.0, 0.0, 1_048_576.0),
    )
    .await;
    assert_eq!(message_type, SYNC_READ);
    let head = unsigned(&reply, "head");
    assert_eq!(head, WRITTEN.len() as u64);
    assert!(unsigned(&reply, "highestSeqNo") >= head);
    assert!(unsigned(&reply, "oldestSeqNo") <= 1);
    assert!(unsigned(&reply, "bytesBehind") > 0);
    let read = entries(&reply);
    assert_eq!(read.len(), WRITTEN.len());
    for (at, (entry, document_id)) in read.iter().zip(WRITTEN).enumerate() {
        assert_eq!(unsigned(entry, "seqNo"), at as u64 + 1);
        assert_eq!(unsigned(entry, "partitionId"), 0);
        assert_eq!(entry.text("documentId"), document_id);
        assert_eq!(title_in(entry), title_of(document_id));
    }

    let (_, smallest) = send(
        &raw,
        &primary.address,
        read_request(LEDGER_UUID, 0.0, 1.0, 1.0),
    )
    .await;
    let read = entries(&smallest);
    assert_eq!(
        read.len(),
        1,
        "a read of one byte still takes the first due entry"
    );
    assert_eq!(unsigned(&read[0], "seqNo"), 2);

    let (_, caught_up) = send(
        &raw,
        &primary.address,
        read_request(LEDGER_UUID, 0.0, head as f64, 1_024.0),
    )
    .await;
    assert!(entries(&caught_up).is_empty());
    assert_eq!(unsigned(&caught_up, "bytesBehind"), 0);

    let refusals = [
        (
            request(&[
                ("indexName", Value::from(LEDGER)),
                ("indexUuid", Value::from(LEDGER_UUID)),
                ("partitionId", Value::Number(0.0)),
                ("afterSeqNo", Value::Number(0.0)),
            ]),
            "CONFIG_INVALID",
        ),
        (read_request(LEDGER_UUID, 0.0, 0.0, 0.0), "CONFIG_INVALID"),
        (
            read_request(LEDGER_UUID, 0.0, -1.0, 1_024.0),
            "CONFIG_INVALID",
        ),
        (
            read_request(LEDGER_UUID, 0.5, 0.0, 1_024.0),
            "CONFIG_INVALID",
        ),
        (
            read_request(LEDGER_UUID, 4_294_967_296.0, 0.0, 1_024.0),
            "CONFIG_INVALID",
        ),
        (b"\xc1".to_vec(), "TRANSPORT_DECODE_FAILED"),
        (
            read_request(ANOTHER_UUID, 0.0, 0.0, 1_024.0),
            "INDEX_NOT_FOUND",
        ),
        (
            read_request(LEDGER_UUID, 7.0, 0.0, 1_024.0),
            "PARTITION_NOT_PRIMARY",
        ),
    ];
    for (payload, code) in refusals {
        let (message_type, refused) = send(&raw, &primary.address, payload).await;
        assert_eq!(message_type, SYNC_READ_REFUSED);
        assert_eq!(refused.text("code"), code);
    }

    primary.stop().await;
    controller.stop().await;
    coordinator.shutdown().await;
}

fn settings_of(stored: &Decoded) -> &Decoded {
    stored
        .field("settings")
        .expect("the metadata keeps its settings")
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rust_node_reads_and_clears_the_sync_settings_that_a_typescript_node_stores() {
    let Some(coordinator) = cluster_coordinator().await else {
        return;
    };
    let controller_scratch = Scratch::new();
    let controller = start_controller(&coordinator, &controller_scratch).await;
    let node_scratch = Scratch::new();
    let node = DataNode::start_with_roles(
        &coordinator,
        "sync-settings",
        node_scratch.path(),
        &["data", "coordinator"],
    )
    .await;
    create_cluster_index(&coordinator, LEDGER, LEDGER_UUID, 1, 0).await;
    eventually("the data node leads the ledger", || {
        is_served_by(&coordinator, LEDGER, LEDGER_UUID, 1, "sync-settings")
    })
    .await;
    let cluster = &node.node;
    assert_eq!(
        cluster.get_sync(LEDGER).await.expect("the setting reads"),
        SyncStatus::default()
    );
    let enabled = SyncSetting {
        enabled: true,
        ..SyncSetting::default()
    };
    let refused = cluster
        .update_sync(LEDGER, &enabled)
        .await
        .expect_err("no backup store");
    assert_eq!(refused.code(), "SYNC_BACKUP_STORE_REQUIRED");
    let zero_limit = SyncSetting {
        enabled: false,
        history_max_bytes: Some(0),
        ..SyncSetting::default()
    };
    let refused = cluster
        .update_sync(LEDGER, &zero_limit)
        .await
        .expect_err("a zero limit");
    assert_eq!(refused.code(), "CONFIG_INVALID");
    let refused = cluster
        .get_sync("narsil-generation-ledger-2")
        .await
        .expect_err("a hidden generation");
    assert_eq!(refused.code(), "CONFIG_INVALID");
    let refused = cluster
        .get_sync("absent-ledger")
        .await
        .expect_err("no such index");
    assert_eq!(refused.code(), "INDEX_NOT_FOUND");

    let key = metadata_key(LEDGER);
    let before = coordinator
        .get(&key)
        .await
        .expect("etcd answers")
        .expect("the ledger has metadata");
    let Ok(Value::Object(mut fields)) = narsil::decode_msgpack(&before) else {
        panic!("the metadata is a map");
    };
    let sync: Map = [
        ("enabled", Value::Bool(true)),
        ("historyMaxBytes", Value::Number(4_096.0)),
    ]
    .into_iter()
    .collect();
    let settings: Map = [
        ("language", Value::from("english")),
        ("sync", Value::Object(sync)),
        ("syncActive", Value::Bool(true)),
        ("syncEpoch", Value::from(TYPESCRIPT_EPOCH)),
    ]
    .into_iter()
    .collect();
    fields.insert("settings", Value::Object(settings));
    let stored = encode_msgpack(&Value::Object(fields)).expect("the metadata encodes");
    assert!(
        coordinator
            .compare_and_set(&key, Some(&before), &stored)
            .await
            .expect("etcd answers")
    );
    assert_eq!(
        cluster.get_sync(LEDGER).await.expect("the setting reads"),
        SyncStatus {
            enabled: true,
            history_max_age_ms: None,
            history_max_bytes: Some(4_096),
            active: true,
            epoch: Some(TYPESCRIPT_EPOCH.to_string()),
        }
    );
    assert_eq!(
        cluster
            .get_changes(LEDGER)
            .await
            .expect("the setting reads"),
        ChangesStatus::default()
    );

    cluster
        .update_sync(LEDGER, &SyncSetting::default())
        .await
        .expect("sync goes off");
    assert_eq!(
        cluster.get_sync(LEDGER).await.expect("the setting reads"),
        SyncStatus::default()
    );
    let after = coordinator
        .get(&key)
        .await
        .expect("etcd answers")
        .expect("the ledger keeps its metadata");
    let after = decode(&after);
    assert_eq!(after.text("indexUuid"), LEDGER_UUID);
    let settings = settings_of(&after);
    assert_eq!(settings.text("language"), "english");
    for field in ["sync", "syncActive", "syncEpoch", "changes"] {
        assert!(
            settings.field(field).is_none(),
            "the cleared settings hold no {field}"
        );
    }

    node.stop().await;
    controller.stop().await;
    coordinator.shutdown().await;
}
