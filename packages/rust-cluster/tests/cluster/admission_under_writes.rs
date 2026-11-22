use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use narsil_cluster::transport::NodeTransport;
use narsil_cluster::transport::tcp::TcpTransport;

mod child_node;
mod data_node;
mod ledger;
mod support;

use child_node::{ChildNode, registered_address, serve_until_killed};
use data_node::{
    DataNode, Scratch, coordinator_at, create_cluster_index, etcd_endpoint, eventually,
    unique_key_prefix,
};
use ledger::{
    FIRST_DATA_NODE, Forwarded, LEDGER, LEDGER_UUID, SECOND_DATA_NODE, first_difference,
    forward_insert, forwarder, placement, start_controller, title_of,
};

const CHILD_TEST: &str = "a_data_node_that_serves_until_its_process_is_killed";
const PARENT_HEARTBEAT_TTL_SECONDS: u64 = 30;
const WRITERS: usize = 4;
const ACKNOWLEDGED_BEFORE_THE_REPLICA_STOPS: usize = 20;
const ACKNOWLEDGED_AFTER_THE_ADMISSION: usize = 40;

type Acknowledged = Arc<Mutex<BTreeMap<String, String>>>;

#[tokio::test(flavor = "multi_thread")]
#[ignore = "the admission test starts this as a separate process and kills it"]
async fn a_data_node_that_serves_until_its_process_is_killed() {
    serve_until_killed().await;
}

fn acknowledged_count(acknowledged: &Acknowledged) -> usize {
    acknowledged.lock().expect("no writer panicked").len()
}

async fn write_until_cut_off(
    forwarder: Arc<TcpTransport>,
    address: String,
    writer: usize,
    acknowledged: Acknowledged,
    killed: Arc<AtomicBool>,
) {
    for serial in 0.. {
        let document_id = format!("writer-{writer}-{serial}");
        match forward_insert(&forwarder, &address, &document_id).await {
            Forwarded::Acknowledged => {
                acknowledged
                    .lock()
                    .expect("no writer panicked")
                    .insert(document_id.clone(), title_of(&document_id));
            }
            Forwarded::Refused(refused) => {
                assert!(
                    killed.load(Ordering::Acquire),
                    "the primary refused {document_id} before it was killed: {refused:?}"
                );
                return;
            }
            Forwarded::Unreachable => return,
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn every_write_acknowledged_while_a_returning_replica_is_admitted_survives_on_it_once_the_primary_is_killed()
 {
    let Some(endpoint) = etcd_endpoint() else {
        return;
    };
    let key_prefix = unique_key_prefix();
    let coordinator = coordinator_at(
        endpoint.clone(),
        key_prefix.clone(),
        PARENT_HEARTBEAT_TTL_SECONDS,
    )
    .await;
    let controller_scratch = Scratch::new();
    let controller = start_controller(&coordinator, &controller_scratch).await;
    let primary_scratch = Scratch::new();
    let mut primary = ChildNode::spawn(
        CHILD_TEST,
        &endpoint,
        &key_prefix,
        FIRST_DATA_NODE,
        &primary_scratch,
    );
    eventually("the primary's process registers its node", || async {
        registered_address(&coordinator, FIRST_DATA_NODE)
            .await
            .is_some()
    })
    .await;
    create_cluster_index(&coordinator, LEDGER, LEDGER_UUID, 1, 1).await;
    eventually("the first data node leads the ledger", || async {
        placement(&coordinator)
            .await
            .is_some_and(|placed| placed.is_led_by(FIRST_DATA_NODE))
    })
    .await;
    let replica_scratch = Scratch::new();
    let replica = DataNode::start(&coordinator, SECOND_DATA_NODE, replica_scratch.path()).await;
    eventually("the replica joins the in-sync set", || async {
        placement(&coordinator)
            .await
            .is_some_and(|placed| placed.admits(SECOND_DATA_NODE))
    })
    .await;

    let address = registered_address(&coordinator, FIRST_DATA_NODE)
        .await
        .expect("the primary is registered");
    let shared_forwarder = Arc::new(forwarder());
    let acknowledged: Acknowledged = Arc::new(Mutex::new(BTreeMap::new()));
    let killed = Arc::new(AtomicBool::new(false));
    let writers: Vec<_> = (0..WRITERS)
        .map(|writer| {
            tokio::spawn(write_until_cut_off(
                Arc::clone(&shared_forwarder),
                address.clone(),
                writer,
                Arc::clone(&acknowledged),
                Arc::clone(&killed),
            ))
        })
        .collect();
    eventually("the primary acknowledges the first writes", || async {
        acknowledged_count(&acknowledged) >= ACKNOWLEDGED_BEFORE_THE_REPLICA_STOPS
    })
    .await;
    replica.stop().await;
    eventually(
        "the primary takes the stopped replica out of the in-sync set",
        || async {
            placement(&coordinator)
                .await
                .is_some_and(|placed| !placed.lists_in_sync(SECOND_DATA_NODE))
        },
    )
    .await;
    let returned = DataNode::start(&coordinator, SECOND_DATA_NODE, replica_scratch.path()).await;
    eventually(
        "the returning replica is admitted while the writes continue",
        || async {
            placement(&coordinator)
                .await
                .is_some_and(|placed| placed.admits(SECOND_DATA_NODE))
        },
    )
    .await;
    let at_admission = acknowledged_count(&acknowledged);
    eventually(
        "the primary acknowledges writes after the admission",
        || async {
            acknowledged_count(&acknowledged) >= at_admission + ACKNOWLEDGED_AFTER_THE_ADMISSION
        },
    )
    .await;
    killed.store(true, Ordering::Release);
    primary.kill();
    for writer in writers {
        writer.await.expect("the writer ends without a panic");
    }

    eventually("the controller promotes the returned replica", || async {
        placement(&coordinator)
            .await
            .is_some_and(|placed| placed.is_led_by(SECOND_DATA_NODE))
    })
    .await;
    let acknowledged = acknowledged.lock().expect("no writer panicked").clone();
    let difference = first_difference(&returned, &acknowledged, &[]).await;
    assert!(
        difference.is_none(),
        "the promoted replica holds all {} acknowledged writes: {difference:?}",
        acknowledged.len()
    );

    shared_forwarder.shutdown().await;
    returned.stop().await;
    controller.stop().await;
    coordinator.shutdown().await;
}
