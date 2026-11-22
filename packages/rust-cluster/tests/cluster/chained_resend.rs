use narsil::Value;
use narsil_cluster::message::TransportMessage;
use narsil_cluster::transport::NodeTransport;

use crate::data_node::{DataNode, Scratch, cluster_coordinator};
use crate::ledger::{
    FORWARDER, LEDGER, LEDGER_UUID, Ledger, placement, start_cluster, title_document,
};
use crate::support::{Decoded, decode, write_binary, write_map_header, write_text, write_unsigned};

const FORWARD_BATCH: &str = "replication.forward_batch";
const WRITE_CONFLICT: &str = "REPLICATION_WRITE_CONFLICT";
const RESENT: &str = "resent-entry";
const FIRST_RESEND: &str = "the first resend";
const CHAINED_RESEND: &str = "the chained resend";
const STALE_RESEND: &str = "a resend that another write overtook";
const FIRST_ABANDONED_SEQ_NO: u64 = 1_000;
const CHAINED_ABANDONED_SEQ_NO: u64 = 2_000;
const STALE_ABANDONED_SEQ_NO: u64 = 3_000;
const UNCHAINED_ABANDONED_SEQ_NO: u64 = 4_000;

struct Resend {
    title: &'static str,
    if_seq_no: u64,
    abandoned_seq_no: u64,
}

fn write_array_header(out: &mut Vec<u8>, count: usize) {
    assert!(count < 16, "a test batch holds fewer than 16 operations");
    out.push(0x90 | count as u8);
}

fn resend_batch(resends: &[Resend], primary_term: u64) -> Vec<u8> {
    let mut out = Vec::new();
    write_map_header(&mut out, 3);
    write_text(&mut out, "indexName");
    write_text(&mut out, LEDGER);
    write_text(&mut out, "operations");
    write_array_header(&mut out, resends.len());
    for resend in resends {
        write_map_header(&mut out, 8);
        write_text(&mut out, "documentId");
        write_text(&mut out, RESENT);
        write_text(&mut out, "operation");
        write_text(&mut out, "update");
        write_text(&mut out, "document");
        write_binary(&mut out, &title_document(resend.title));
        for (name, number) in [
            ("ifSeqNo", resend.if_seq_no),
            ("ifPrimaryTerm", primary_term),
            ("abandonedSeqNo", resend.abandoned_seq_no),
            ("abandonedPrimaryTerm", primary_term),
            ("compensationSeqNo", resend.abandoned_seq_no + 1),
        ] {
            write_text(&mut out, name);
            write_unsigned(&mut out, number);
        }
    }
    write_text(&mut out, "indexUuid");
    write_text(&mut out, LEDGER_UUID);
    out
}

async fn send_resends(
    ledger: &Ledger,
    primary: &DataNode,
    resends: &[Resend],
    primary_term: u64,
) -> Vec<Decoded> {
    let request = TransportMessage::new(
        FORWARD_BATCH,
        FORWARDER,
        "resends",
        resend_batch(resends, primary_term),
    );
    let answer = ledger
        .forwarder
        .send(&primary.address, request)
        .await
        .expect("the primary answers the batch");
    let decoded = decode(&answer.payload);
    assert_eq!(answer.message_type, FORWARD_BATCH, "{decoded:?}");
    match decoded.field("results") {
        Some(Decoded::List(results)) => results.clone(),
        other => panic!("the batch answered no results: {other:?}"),
    }
}

fn succeeded(result: &Decoded) -> bool {
    result.field("success") == Some(&Decoded::Bool(true))
}

fn refused_with(result: &Decoded) -> String {
    assert_eq!(
        result.field("success"),
        Some(&Decoded::Bool(false)),
        "{result:?}"
    );
    result.text("errorCode")
}

async fn title_held(node: &DataNode) -> Option<String> {
    let held = node
        .node
        .local_document(LEDGER, RESENT)
        .await
        .expect("the copy answers");
    held.and_then(|document| {
        document
            .get("title")
            .and_then(Value::as_str)
            .map(str::to_string)
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rust_primary_applies_a_chained_resend_in_the_same_batch_and_replicates_it() {
    let Some(coordinator) = cluster_coordinator().await else {
        return;
    };
    let controller_scratch = Scratch::new();
    let (controller, mut members, primary_at) =
        start_cluster(&coordinator, &controller_scratch).await;
    let mut ledger = Ledger::new();
    ledger
        .insert_all(members[primary_at].data(), &[RESENT.to_string()])
        .await;
    let primary_term = placement(&coordinator)
        .await
        .expect("the ledger is placed")
        .primary_term as u64;
    let inserted_seq_no = 1;

    let results = send_resends(
        &ledger,
        members[primary_at].data(),
        &[
            Resend {
                title: FIRST_RESEND,
                if_seq_no: inserted_seq_no,
                abandoned_seq_no: FIRST_ABANDONED_SEQ_NO,
            },
            Resend {
                title: CHAINED_RESEND,
                if_seq_no: FIRST_ABANDONED_SEQ_NO,
                abandoned_seq_no: CHAINED_ABANDONED_SEQ_NO,
            },
            Resend {
                title: STALE_RESEND,
                if_seq_no: inserted_seq_no,
                abandoned_seq_no: STALE_ABANDONED_SEQ_NO,
            },
        ],
        primary_term,
    )
    .await;
    let [first, chained, stale] = results.as_slice() else {
        panic!("the batch answers each operation: {results:?}");
    };
    assert!(succeeded(first), "{first:?}");
    assert!(succeeded(chained), "{chained:?}");
    assert_eq!(refused_with(stale), WRITE_CONFLICT);

    let alone = send_resends(
        &ledger,
        members[primary_at].data(),
        &[Resend {
            title: STALE_RESEND,
            if_seq_no: CHAINED_ABANDONED_SEQ_NO,
            abandoned_seq_no: UNCHAINED_ABANDONED_SEQ_NO,
        }],
        primary_term,
    )
    .await;
    let [unchained] = alone.as_slice() else {
        panic!("the batch answers its operation: {alone:?}");
    };
    assert_eq!(
        refused_with(unchained),
        WRITE_CONFLICT,
        "a resend chains only to an earlier resend in the same batch"
    );
    for member in &members {
        assert_eq!(
            title_held(member.data()).await.as_deref(),
            Some(CHAINED_RESEND),
            "{} holds the chained resend",
            member.node_id
        );
    }

    ledger.forwarder.shutdown().await;
    for member in &mut members {
        member.stop().await;
    }
    controller.stop().await;
    coordinator.shutdown().await;
}
