use std::sync::Arc;
use std::time::Duration;

use narsil::Value;
use narsil_cluster::message::TransportMessage;
use narsil_cluster::transport::tcp::{TcpTransport, TcpTransportConfig};
use narsil_cluster::transport::{NodeTransport, listen_handler};
use tokio::sync::Notify;

use crate::data_node::{
    DataNode, Scratch, cluster_coordinator, create_cluster_index, eventually, is_served_by,
};
use crate::ledger::start_controller;
use crate::support::{decode, write_map_header, write_text, write_unsigned};

const INDEX: &str = "shutdown-ledger";
const UUID: &str = "shutdown-ledger-uuid";
const PRIMARY: &str = "shutdown-primary";
const SHUTDOWN_BOUND: Duration = Duration::from_secs(3);
const ARRIVAL_BOUND: Duration = Duration::from_secs(10);

#[tokio::test(flavor = "multi_thread")]
async fn shutdown_releases_a_write_while_a_handover_waits_for_its_replica() {
    let Some(coordinator) = cluster_coordinator().await else {
        return;
    };
    let controller_directory = Scratch::new();
    let primary_directory = Scratch::new();
    let controller = start_controller(&coordinator, &controller_directory).await;
    let primary = DataNode::start(&coordinator, PRIMARY, primary_directory.path()).await;
    create_cluster_index(&coordinator, INDEX, UUID, 1, 0).await;
    eventually("the primary serves the ledger", || async {
        is_served_by(&coordinator, INDEX, UUID, 1, PRIMARY).await
    })
    .await;
    primary
        .node
        .remove(INDEX, "never-stored")
        .await
        .expect_err("the empty partition starts its term");
    controller.stop().await;

    let replica = TcpTransport::new(
        "silent-replica",
        TcpTransportConfig {
            host: "127.0.0.1".to_string(),
            port: 0,
            ..TcpTransportConfig::default()
        },
    )
    .expect("the replica transport is configured");
    let arrived = Arc::new(Notify::new());
    let observed = Arc::clone(&arrived);
    replica
        .listen(listen_handler(
            move |message: TransportMessage, _respond| {
                let observed = Arc::clone(&observed);
                async move {
                    if message.message_type == "replication.term_start" {
                        observed.notify_one();
                    }
                    std::future::pending::<()>().await;
                    Ok(())
                }
            },
        ))
        .await
        .expect("the replica listens");
    let target = format!("127.0.0.1:{}", replica.port());
    let mut table = coordinator
        .allocation(INDEX)
        .await
        .expect("etcd answers")
        .expect("the table exists");
    let (_, assignment) = table.assignments.first_mut().expect("the partition exists");
    let term = assignment
        .get("primaryTerm")
        .and_then(Value::as_f64)
        .expect("the term is numeric") as u64;
    assignment.insert("replicas", Value::Array(vec![Value::from(target.as_str())]));
    assignment.insert(
        "inSyncSet",
        Value::Array(vec![Value::from(target.as_str())]),
    );
    table.version += 1.0;
    coordinator
        .put_allocation(INDEX, &table)
        .await
        .expect("etcd lists the replica");

    let mut payload = Vec::new();
    write_map_header(&mut payload, 5);
    write_text(&mut payload, "indexName");
    write_text(&mut payload, INDEX);
    write_text(&mut payload, "partitionId");
    write_unsigned(&mut payload, 0);
    write_text(&mut payload, "primaryTerm");
    write_unsigned(&mut payload, term);
    write_text(&mut payload, "targetNodeId");
    write_text(&mut payload, &target);
    write_text(&mut payload, "action");
    write_text(&mut payload, "block");
    let forwarding = Arc::new(
        TcpTransport::new("handover-controller", TcpTransportConfig::default())
            .expect("the sender is configured"),
    );
    let sender = Arc::clone(&forwarding);
    let address = primary.address.clone();
    let handover = tokio::spawn(async move {
        sender
            .send(
                &address,
                TransportMessage::new(
                    "cluster.lead_handoff",
                    "handover-controller",
                    "handover",
                    payload,
                ),
            )
            .await
    });
    tokio::time::timeout(ARRIVAL_BOUND, arrived.notified())
        .await
        .expect("the replica receives the confirmation");
    let removing = primary.node.remove(INDEX, "never-stored");
    tokio::pin!(removing);
    tokio::select! {
        result = &mut removing => panic!("the handover must hold the write: {result:?}"),
        () = tokio::time::sleep(Duration::from_millis(100)) => {}
    }
    let drained = tokio::time::timeout(SHUTDOWN_BOUND, async {
        tokio::join!(primary.node.shutdown(), &mut removing)
    })
    .await
    .expect("shutdown releases the handover and its queued write");
    assert_eq!(
        drained.1.expect_err("the document never existed").code(),
        "DOC_NOT_FOUND"
    );
    let refused = handover
        .await
        .expect("the handover task completes")
        .expect("the primary answers");
    assert_eq!(decode(&refused.payload).text("code"), "ALLOCATION_FAILED");
    forwarding.shutdown().await;
    replica.shutdown().await;
    primary.transport.shutdown().await;
    coordinator.shutdown().await;
}
