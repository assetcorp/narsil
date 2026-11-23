use narsil::{Map, MemoryConfig, Value};
use narsil_cluster::coordinator::etcd::{EtcdCoordinator, EtcdCoordinatorConfig};
use narsil_cluster::coordinator::{NodeCapacity, NodeRegistration};
use narsil_cluster::node::{ClusterNodeConfig, next_started_at};

use crate::data_node::{
    DataNode, Scratch, coordinator_at, create_cluster_index, etcd_endpoint, eventually,
    is_served_by, unique_key_prefix,
};
use crate::ledger::{
    Forwarded, LEDGER, LEDGER_UUID, forward_insert, forward_write, forwarder, start_controller,
};
use crate::support::Decoded;
use crate::typescript_node::TypescriptNode;

const CLUSTER_WRITE_BLOCKED: &str = "CLUSTER_WRITE_BLOCKED";
const NODE_MEMORY_FULL: &str = "node_memory_full";
const FULL_NODE: &str = "memory-full-node";
const PRIMARY: &str = "memory-primary";
const BLOCK_ARRIVAL_ATTEMPTS: u32 = 100;
const BLOCK_ARRIVAL_PAUSE: std::time::Duration = std::time::Duration::from_millis(50);
const STAND_IN: &str = "memory-stand-in";
const ALWAYS_FULL: MemoryConfig = MemoryConfig {
    block_writes_above: Some(0.000_001),
    resume_writes_below: Some(0.000_000_5),
};
const MEBIBYTE: f64 = 1_048_576.0;
const GIBIBYTE: f64 = 1_073_741_824.0;

fn always_full(config: &mut ClusterNodeConfig) {
    if let Some(data) = config.data.as_mut() {
        data.engine.memory = Some(ALWAYS_FULL);
    }
}

fn title(text: &str) -> Map {
    [("title", Value::from(text))].into_iter().collect()
}

async fn registered_full(coordinator: &EtcdCoordinator, node_id: &str) -> Option<bool> {
    let nodes = coordinator.list_nodes().await.ok()?;
    let node = nodes.into_iter().find(|node| node.node_id == node_id)?;
    match node.extra.get("memory") {
        Some(Value::Object(memory)) => match memory.get("full") {
            Some(Value::Bool(full)) => Some(*full),
            _ => None,
        },
        _ => None,
    }
}

async fn stand_in_holds_a_copy(coordinator: &EtcdCoordinator) -> bool {
    let Ok(Some(table)) = coordinator.allocation(LEDGER).await else {
        return false;
    };
    table.assignments.into_iter().any(|(_, fields)| {
        matches!(fields.get("replicas"), Some(Value::Array(replicas)) if replicas.contains(&Value::from(STAND_IN)))
    })
}

fn stand_in_memory(process_bytes: f64, full: bool) -> Value {
    let memory: Map = [
        ("processBytes", Value::Number(process_bytes)),
        ("processLimitBytes", Value::Number(GIBIBYTE)),
        ("heapBytes", Value::Number(50.0 * MEBIBYTE)),
        ("heapLimitBytes", Value::Number(GIBIBYTE)),
        ("full", Value::Bool(full)),
    ]
    .into_iter()
    .collect();
    Value::Object(memory)
}

fn stand_in(memory: Value) -> NodeRegistration {
    NodeRegistration {
        node_id: STAND_IN.to_string(),
        address: "127.0.0.1:9".to_string(),
        roles: vec!["data".to_string()],
        capacity: NodeCapacity::default(),
        started_at: next_started_at(),
        version: narsil_cluster::SPEC_VERSION.to_string(),
        extra: [("memory", memory)].into_iter().collect(),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rust_primary_refuses_the_inserts_and_updates_that_every_node_sends_it_while_a_copy_holder_is_full()
 {
    let Some(endpoint) = etcd_endpoint() else {
        return;
    };
    let key_prefix = unique_key_prefix();
    let ttl = EtcdCoordinatorConfig::default().node_heartbeat_ttl_seconds;
    let coordinator = coordinator_at(endpoint.clone(), key_prefix.clone(), ttl).await;
    let controller_scratch = Scratch::new();
    let controller = start_controller(&coordinator, &controller_scratch).await;
    let full_scratch = Scratch::new();
    let full = DataNode::start_configured(
        &coordinator,
        FULL_NODE,
        full_scratch.path(),
        &["data"],
        always_full,
    )
    .await;
    assert_eq!(registered_full(&coordinator, FULL_NODE).await, Some(true));
    let primary_scratch = Scratch::new();
    let primary = DataNode::start(&coordinator, PRIMARY, primary_scratch.path()).await;
    create_cluster_index(&coordinator, LEDGER, LEDGER_UUID, 1, 1).await;
    eventually("the node with room leads the ledger", || {
        is_served_by(&coordinator, LEDGER, LEDGER_UUID, 1, PRIMARY)
    })
    .await;
    let raw = forwarder();
    assert!(matches!(
        forward_insert(&raw, &primary.address, "before-block").await,
        Forwarded::Acknowledged
    ));
    coordinator
        .register_node(&stand_in(stand_in_memory(100.0 * MEBIBYTE, false)))
        .await
        .expect("etcd takes the stand-in's registration");
    eventually("the stand-in holds the ledger's replica", || {
        stand_in_holds_a_copy(&coordinator)
    })
    .await;
    coordinator
        .register_node(&stand_in(stand_in_memory(950.0 * MEBIBYTE, true)))
        .await
        .expect("etcd takes the stand-in's full registration");

    let mut refused_ids = Vec::new();
    let mut serial = 0;
    loop {
        serial += 1;
        let document_id = format!("forwarded-{serial}");
        let forwarded = forward_insert(&raw, &primary.address, &document_id).await;
        refused_ids.push(document_id);
        if let Forwarded::Refused(answer) = forwarded {
            let details = answer
                .field("details")
                .expect("the refusal carries details");
            assert_eq!(answer.text("code"), CLUSTER_WRITE_BLOCKED);
            assert_eq!(details.text("reason"), NODE_MEMORY_FULL);
            assert_eq!(
                details.field("fullNodeIds"),
                Some(&Decoded::List(vec![Decoded::Text(STAND_IN.to_string())]))
            );
            break;
        }
        assert!(
            serial < BLOCK_ARRIVAL_ATTEMPTS,
            "the primary learns of the block"
        );
        tokio::time::sleep(BLOCK_ARRIVAL_PAUSE).await;
    }
    let refused_id = refused_ids.last().expect("one write was refused").clone();
    let forwarded =
        forward_write(&raw, &primary.address, "update", "before-block", "renamed").await;
    let Forwarded::Refused(answer) = forwarded else {
        panic!("the primary refuses the forwarded update");
    };
    assert_eq!(answer.text("code"), CLUSTER_WRITE_BLOCKED);

    let mut typescript = TypescriptNode::start(
        &endpoint,
        &key_prefix,
        "memory-ts-coordinator",
        "coordinator",
    )
    .await;
    let answer = typescript
        .insert(LEDGER, "from-typescript", "oak table")
        .await;
    assert_eq!(answer.code(), Some(CLUSTER_WRITE_BLOCKED));
    let answer = typescript
        .update(LEDGER, "from-typescript", "renamed")
        .await;
    assert_eq!(answer.code(), Some(CLUSTER_WRITE_BLOCKED));

    let entry_scratch = Scratch::new();
    let entry = DataNode::start_with_roles(
        &coordinator,
        "memory-rust-coordinator",
        entry_scratch.path(),
        &["coordinator"],
    )
    .await;
    let refused = entry
        .node
        .insert(LEDGER, title("pine table"), Some("from-rust"))
        .await
        .expect_err("the full primary blocks the insert");
    assert_eq!(refused.code(), CLUSTER_WRITE_BLOCKED);
    let refused = entry
        .node
        .insert_batch(
            LEDGER,
            vec![
                [
                    ("id", Value::from("batch-1")),
                    ("title", Value::from("ash table")),
                ]
                .into_iter()
                .collect(),
                [
                    ("id", Value::from("batch-2")),
                    ("title", Value::from("elm table")),
                ]
                .into_iter()
                .collect(),
            ],
        )
        .await
        .expect_err("the block refuses the whole batch");
    assert_eq!(refused.code(), CLUSTER_WRITE_BLOCKED);

    let before = primary
        .node
        .local_document(LEDGER, "before-block")
        .await
        .expect("the primary reads its copy")
        .expect("the primary keeps the write from before the block");
    assert_eq!(
        before.get("title"),
        Some(&Value::from("entry before-block"))
    );
    for absent in [
        refused_id.as_str(),
        "from-typescript",
        "from-rust",
        "batch-1",
        "batch-2",
    ] {
        assert_eq!(
            primary
                .node
                .local_document(LEDGER, absent)
                .await
                .expect("the primary reads its copy"),
            None,
            "the primary holds no copy of {absent}"
        );
    }
    typescript.shutdown().await;
    entry.stop().await;
    primary.stop().await;
    full.stop().await;
    controller.stop().await;
    coordinator.shutdown().await;
}
