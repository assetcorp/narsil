use narsil_cluster::message::TransportMessage;
use narsil_cluster::transport::NodeTransport;

mod data_node;
mod ledger;
mod support;

use data_node::{Scratch, cluster_coordinator};
use ledger::{
    FORWARDER, Forwarded, LEDGER, LEDGER_UUID, forward_insert, forwarder, start_cluster,
    title_document,
};
use support::{Decoded, decode, write_binary, write_map_header, write_text};

const FORWARD_BATCH: &str = "replication.forward_batch";
const NOT_PRIMARY: &str = "PARTITION_NOT_PRIMARY";
const SINGLE_DOCUMENT_ID: &str = "sent-to-the-replica-alone";
const BATCH_DOCUMENT_ID: &str = "sent-to-the-replica-in-a-batch";

fn batch_payload(document_id: &str) -> Vec<u8> {
    let mut out = Vec::new();
    write_map_header(&mut out, 3);
    write_text(&mut out, "indexName");
    write_text(&mut out, LEDGER);
    write_text(&mut out, "operations");
    out.push(0x91);
    write_map_header(&mut out, 3);
    write_text(&mut out, "documentId");
    write_text(&mut out, document_id);
    write_text(&mut out, "operation");
    write_text(&mut out, "insert");
    write_text(&mut out, "document");
    write_binary(&mut out, &title_document(document_id));
    write_text(&mut out, "indexUuid");
    write_text(&mut out, LEDGER_UUID);
    out
}

fn sorted_keys(details: &Decoded) -> Vec<&str> {
    let mut keys = details.keys();
    keys.sort_unstable();
    keys
}

#[tokio::test(flavor = "multi_thread")]
async fn a_replica_refuses_a_forwarded_write_and_a_forwarded_batch_with_the_details_that_typescript_sends()
 {
    let Some(coordinator) = cluster_coordinator().await else {
        return;
    };
    let controller_scratch = Scratch::new();
    let (controller, mut members, primary_at) =
        start_cluster(&coordinator, &controller_scratch).await;
    let replica_at = 1 - primary_at;
    let (primary_id, replica_id) = (members[primary_at].node_id, members[replica_at].node_id);
    let replica_address = members[replica_at].data().address.clone();
    let sender = forwarder();

    let Forwarded::Refused(single) =
        forward_insert(&sender, &replica_address, SINGLE_DOCUMENT_ID).await
    else {
        panic!("the replica takes a forwarded write that it does not lead");
    };
    assert_eq!(single.text("code"), NOT_PRIMARY);
    let details = single
        .field("details")
        .expect("the refusal carries details");
    assert_eq!(
        sorted_keys(details),
        ["indexName", "localNodeId", "partitionId", "primaryNodeId"]
    );
    assert_eq!(details.text("primaryNodeId"), primary_id);
    assert_eq!(details.text("localNodeId"), replica_id);
    assert_eq!(details.text("indexName"), LEDGER);
    assert_eq!(details.unsigned("partitionId"), 0);

    let request = TransportMessage::new(
        FORWARD_BATCH,
        FORWARDER,
        BATCH_DOCUMENT_ID,
        batch_payload(BATCH_DOCUMENT_ID),
    );
    let answer = sender
        .send(&replica_address, request)
        .await
        .expect("the replica answers the batch");
    assert_eq!(answer.message_type, FORWARD_BATCH);
    let results = match decode(&answer.payload).field("results") {
        Some(Decoded::List(results)) => results.clone(),
        other => panic!("the batch answered no results: {other:?}"),
    };
    let [result] = results.as_slice() else {
        panic!("the batch answered {} results for one write", results.len());
    };
    assert_eq!(result.text("documentId"), BATCH_DOCUMENT_ID);
    assert_eq!(result.field("success"), Some(&Decoded::Bool(false)));
    assert_eq!(result.text("errorCode"), NOT_PRIMARY);
    let details = result
        .field("errorDetails")
        .expect("the refused result carries details");
    assert_eq!(sorted_keys(details), ["indexName", "nodeId", "partitionId"]);
    assert_eq!(details.text("nodeId"), replica_id);
    assert_eq!(details.text("indexName"), LEDGER);
    assert_eq!(details.unsigned("partitionId"), 0);

    for member in [&members[primary_at], &members[replica_at]] {
        for document_id in [SINGLE_DOCUMENT_ID, BATCH_DOCUMENT_ID] {
            assert!(
                matches!(
                    member.data().node.local_document(LEDGER, document_id).await,
                    Ok(None)
                ),
                "{} holds {document_id}, which only the replica was sent",
                member.node_id
            );
        }
    }

    sender.shutdown().await;
    for member in &mut members {
        member.stop().await;
    }
    controller.stop().await;
    coordinator.shutdown().await;
}
