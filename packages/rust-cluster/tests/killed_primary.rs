use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use narsil_cluster::coordinator::etcd::EtcdCoordinator;
use narsil_cluster::node::ClusterNodeConfig;
use narsil_cluster::transport::NodeTransport;
use narsil_cluster::transport::tcp::TcpTransport;

mod data_node;
mod ledger;
mod support;

use data_node::{
    DataNode, Scratch, coordinator_at, create_cluster_index, etcd_endpoint, eventually,
    unique_key_prefix,
};
use ledger::{
    FIRST_DATA_NODE, Forwarded, LEDGER, LEDGER_UUID, Ledger, SECOND_DATA_NODE, first_difference,
    forward_insert, forwarder, placement, start_controller, title_of,
};

const CHILD_ENDPOINT: &str = "NARSIL_KILLED_PRIMARY_ETCD_ENDPOINT";
const CHILD_KEY_PREFIX: &str = "NARSIL_KILLED_PRIMARY_KEY_PREFIX";
const CHILD_DIRECTORY: &str = "NARSIL_KILLED_PRIMARY_DIRECTORY";
const CHILD_TEST: &str = "a_data_node_that_runs_until_its_process_is_killed";
const CHILD_HEARTBEAT_TTL_SECONDS: u64 = 2;
const CHILD_HEARTBEAT_INTERVAL_MS: u64 = 500;
const PARENT_HEARTBEAT_TTL_SECONDS: u64 = 30;
const WRITERS: usize = 4;
const ACKNOWLEDGED_BEFORE_THE_KILL: usize = 40;

type Acknowledged = Arc<Mutex<BTreeMap<String, String>>>;

fn beat_often(settings: &mut ClusterNodeConfig) {
    settings.heartbeat_interval_ms = CHILD_HEARTBEAT_INTERVAL_MS;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "the killed-primary test starts this as a separate process and kills it"]
async fn a_data_node_that_runs_until_its_process_is_killed() {
    let (Ok(endpoint), Ok(key_prefix), Ok(directory)) = (
        std::env::var(CHILD_ENDPOINT),
        std::env::var(CHILD_KEY_PREFIX),
        std::env::var(CHILD_DIRECTORY),
    ) else {
        return;
    };
    let coordinator = coordinator_at(endpoint, key_prefix, CHILD_HEARTBEAT_TTL_SECONDS).await;
    let _node = DataNode::start_configured(
        &coordinator,
        FIRST_DATA_NODE,
        &PathBuf::from(directory),
        &["data"],
        beat_often,
    )
    .await;
    std::future::pending::<()>().await;
}

struct PrimaryProcess(Child);

impl PrimaryProcess {
    fn kill(&mut self) {
        self.0.kill().expect("the primary's process is killed");
        self.0.wait().expect("the primary's process exits");
    }
}

impl Drop for PrimaryProcess {
    fn drop(&mut self) {
        if matches!(self.0.try_wait(), Ok(None)) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

fn spawn_primary_process(endpoint: &str, key_prefix: &str, directory: &Scratch) -> PrimaryProcess {
    let child = Command::new(std::env::current_exe().expect("the test binary has a path"))
        .args([CHILD_TEST, "--exact", "--ignored", "--test-threads=1"])
        .env(CHILD_ENDPOINT, endpoint)
        .env(CHILD_KEY_PREFIX, key_prefix)
        .env(CHILD_DIRECTORY, directory.path())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("the primary's process starts");
    PrimaryProcess(child)
}

async fn registered_address(coordinator: &EtcdCoordinator, node_id: &str) -> Option<String> {
    coordinator
        .list_nodes()
        .await
        .expect("etcd lists the nodes")
        .into_iter()
        .find(|node| node.node_id == node_id)
        .map(|node| node.address)
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
async fn every_write_that_a_killed_rust_primary_acknowledged_survives_on_the_promoted_replica() {
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
    let mut primary = spawn_primary_process(&endpoint, &key_prefix, &primary_scratch);
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
            .is_some_and(|placed| placed.state == "ACTIVE" && placed.primary == FIRST_DATA_NODE)
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
        acknowledged.lock().expect("no writer panicked").len() >= ACKNOWLEDGED_BEFORE_THE_KILL
    })
    .await;
    killed.store(true, Ordering::Release);
    primary.kill();
    for writer in writers {
        writer.await.expect("the writer ends without a panic");
    }

    eventually("the controller promotes the in-sync replica", || async {
        placement(&coordinator)
            .await
            .is_some_and(|placed| placed.state == "ACTIVE" && placed.primary == SECOND_DATA_NODE)
    })
    .await;
    let acknowledged = acknowledged.lock().expect("no writer panicked").clone();
    let difference = first_difference(&replica, &acknowledged, &[]).await;
    assert!(
        difference.is_none(),
        "the promoted replica holds all {} acknowledged writes: {difference:?}",
        acknowledged.len()
    );
    let mut ledger = Ledger::new();
    ledger
        .insert_until_accepted(&replica, "after-the-kill")
        .await;
    assert!(
        first_difference(&replica, &ledger.written, &[])
            .await
            .is_none()
    );

    ledger.forwarder.shutdown().await;
    shared_forwarder.shutdown().await;
    replica.stop().await;
    controller.stop().await;
    coordinator.shutdown().await;
}
