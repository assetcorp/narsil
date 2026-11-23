use std::collections::BTreeMap;
use std::sync::Arc;

use narsil_cluster::coordinator::etcd::{EtcdCoordinator, EtcdCoordinatorConfig};

use crate::data_node::{
    DataNode, Scratch, coordinator_at, create_cluster_index, etcd_endpoint, eventually,
    unique_key_prefix,
};
use crate::ledger::{
    DIVERGED_DOCUMENT_ID, FIRST_DATA_NODE, LEDGER, LEDGER_UUID, Member, SECOND_DATA_NODE,
    holds_exactly, placement, start_controller, title_of,
};
use crate::spread::titled;
use crate::typescript_node::TypescriptNode;

const TYPESCRIPT_DATA_NODE: &str = "ledger-typescript-data";
const ROUTER: &str = "ledger-router";
type Written = BTreeMap<String, String>;

struct MixedCluster {
    endpoint: String,
    key_prefix: String,
    coordinator: Arc<EtcdCoordinator>,
    controller: DataNode,
    router: Option<DataNode>,
    scratches: [Scratch; 3],
}

impl MixedCluster {
    async fn start() -> Option<MixedCluster> {
        let endpoint = etcd_endpoint()?;
        let key_prefix = unique_key_prefix();
        let ttl = EtcdCoordinatorConfig::default().node_heartbeat_ttl_seconds;
        let coordinator = coordinator_at(endpoint.clone(), key_prefix.clone(), ttl).await;
        let scratches = [Scratch::new(), Scratch::new(), Scratch::new()];
        let controller = start_controller(&coordinator, &scratches[0]).await;
        Some(MixedCluster {
            endpoint,
            key_prefix,
            coordinator,
            controller,
            router: None,
            scratches,
        })
    }

    async fn typescript_data_node(&self) -> TypescriptNode {
        TypescriptNode::start_durable(
            &self.endpoint,
            &self.key_prefix,
            TYPESCRIPT_DATA_NODE,
            "data",
            self.scratches[2].path(),
        )
        .await
    }

    async fn create_ledger_led_by(&mut self, node_id: &str) {
        create_cluster_index(&self.coordinator, LEDGER, LEDGER_UUID, 1, 1).await;
        self.led_by(node_id, "the first data node leads the ledger")
            .await;
        let router = DataNode::start_with_roles(
            &self.coordinator,
            ROUTER,
            self.scratches[1].path(),
            &["coordinator"],
        )
        .await;
        self.router = Some(router);
    }

    async fn led_by(&self, node_id: &str, what: &str) {
        eventually(what, || async {
            placement(&self.coordinator)
                .await
                .is_some_and(|placed| placed.is_led_by(node_id))
        })
        .await;
    }

    async fn admitted(&self, node_id: &str, what: &str) {
        eventually(what, || async {
            placement(&self.coordinator)
                .await
                .is_some_and(|placed| placed.admits(node_id))
        })
        .await;
    }

    async fn write(&self, prefix: &str, count: usize, written: &mut Written) {
        let router = self.router.as_ref().expect("the ledger has a router");
        for serial in 0..count {
            let document_id = format!("{prefix}-{serial}");
            let title = title_of(&document_id);
            router
                .node
                .insert(LEDGER, titled(&title), Some(&document_id))
                .await
                .unwrap_or_else(|error| panic!("the primary takes {document_id}: {error:?}"));
            written.insert(document_id, title);
        }
    }

    async fn stop(self) {
        if let Some(router) = self.router {
            router.stop().await;
        }
        self.controller.stop().await;
        self.coordinator.shutdown().await;
    }
}

async fn typescript_copy_difference(
    node: &mut TypescriptNode,
    written: &Written,
) -> Option<String> {
    for (document_id, title) in written {
        let held = node.title(LEDGER, document_id).await;
        if held.as_deref() != Some(title.as_str()) {
            return Some(format!(
                "{document_id} should read '{title}' and reads {held:?}"
            ));
        }
    }
    None
}

#[tokio::test(flavor = "multi_thread")]
async fn a_returning_rust_replica_catches_up_from_a_typescript_primary() {
    let Some(mut cluster) = MixedCluster::start().await else {
        return;
    };
    let primary = cluster.typescript_data_node().await;
    cluster.create_ledger_led_by(TYPESCRIPT_DATA_NODE).await;
    let mut replica = Member::start(&cluster.coordinator, SECOND_DATA_NODE).await;
    cluster
        .admitted(SECOND_DATA_NODE, "the Rust replica joins the in-sync set")
        .await;
    let mut written = Written::new();
    cluster.write("admitted", 20, &mut written).await;
    assert!(holds_exactly(replica.data(), &written, &[]).await);

    replica.stop().await;
    cluster.write("while-away", 30, &mut written).await;
    let away = placement(&cluster.coordinator)
        .await
        .expect("the ledger is placed");
    assert!(!away.lists_in_sync(SECOND_DATA_NODE));
    replica.restart(&cluster.coordinator).await;
    cluster
        .admitted(
            SECOND_DATA_NODE,
            "the returning Rust replica is admitted again",
        )
        .await;
    assert!(
        holds_exactly(replica.data(), &written, &[]).await,
        "the returning Rust replica holds every write that the TypeScript primary acknowledged"
    );
    cluster.write("after-return", 10, &mut written).await;
    assert!(holds_exactly(replica.data(), &written, &[]).await);

    replica.stop().await;
    primary.shutdown().await;
    cluster.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_returning_typescript_replica_catches_up_from_a_rust_primary() {
    let Some(mut cluster) = MixedCluster::start().await else {
        return;
    };
    let mut primary = Member::start(&cluster.coordinator, FIRST_DATA_NODE).await;
    cluster.create_ledger_led_by(FIRST_DATA_NODE).await;
    let replica = cluster.typescript_data_node().await;
    cluster
        .admitted(
            TYPESCRIPT_DATA_NODE,
            "the TypeScript replica joins the in-sync set",
        )
        .await;
    let mut written = Written::new();
    cluster.write("admitted", 20, &mut written).await;

    replica.shutdown().await;
    cluster.write("while-away", 30, &mut written).await;
    let replica = cluster.typescript_data_node().await;
    cluster
        .admitted(
            TYPESCRIPT_DATA_NODE,
            "the returning TypeScript replica is admitted again",
        )
        .await;
    cluster.write("after-return", 10, &mut written).await;
    replica.shutdown().await;
    cluster.write("past-the-log", 5, &mut written).await;
    primary.stop().await;
    primary.restart(&cluster.coordinator).await;
    cluster
        .led_by(FIRST_DATA_NODE, "the restarted Rust primary leads again")
        .await;
    let mut replica = cluster.typescript_data_node().await;
    cluster
        .admitted(
            TYPESCRIPT_DATA_NODE,
            "the TypeScript replica is admitted after a snapshot from the Rust primary",
        )
        .await;
    cluster.write("after-snapshot", 5, &mut written).await;
    primary.stop().await;
    cluster
        .led_by(
            TYPESCRIPT_DATA_NODE,
            "the controller promotes the TypeScript replica",
        )
        .await;
    let difference = typescript_copy_difference(&mut replica, &written).await;
    assert!(
        difference.is_none(),
        "the promoted TypeScript copy holds every write that the Rust primary acknowledged: {difference:?}"
    );

    replica.shutdown().await;
    cluster.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rust_replica_with_an_entry_from_an_earlier_term_takes_a_snapshot_from_a_typescript_primary()
 {
    let Some(mut cluster) = MixedCluster::start().await else {
        return;
    };
    let mut departed = Member::start(&cluster.coordinator, FIRST_DATA_NODE).await;
    cluster.create_ledger_led_by(FIRST_DATA_NODE).await;
    let mut successor = cluster.typescript_data_node().await;
    cluster
        .admitted(
            TYPESCRIPT_DATA_NODE,
            "the TypeScript replica joins the in-sync set",
        )
        .await;
    let mut written = Written::new();
    cluster.write("before-failover", 5, &mut written).await;
    let first_term = placement(&cluster.coordinator)
        .await
        .expect("the ledger is placed")
        .primary_term;

    departed.stop().await;
    eventually(
        "the controller promotes the TypeScript replica and keeps the departed primary as its replica",
        || async {
            placement(&cluster.coordinator).await.is_some_and(|placed| {
                placed.is_led_by(TYPESCRIPT_DATA_NODE) && placed.replica() == Some(FIRST_DATA_NODE)
            })
        },
    )
    .await;
    let promoted_term = placement(&cluster.coordinator)
        .await
        .expect("the ledger is placed")
        .primary_term;
    assert!(promoted_term > first_term);
    let diverged_title = "written by the departed primary and never replicated";
    let (_, diverged_term) = departed.diverge_while_stopped(diverged_title);
    assert!((diverged_term as f64) < promoted_term);
    cluster.write("after-failover", 1, &mut written).await;
    departed.restart(&cluster.coordinator).await;
    cluster
        .admitted(
            FIRST_DATA_NODE,
            "the diverged Rust copy is admitted after a snapshot from the TypeScript primary",
        )
        .await;
    cluster.write("after-snapshot", 3, &mut written).await;
    let placed = placement(&cluster.coordinator)
        .await
        .expect("the ledger is placed");
    assert!(placed.is_led_by(TYPESCRIPT_DATA_NODE));
    assert_eq!(placed.primary_term, promoted_term);
    assert!(
        holds_exactly(
            departed.data(),
            &written,
            &[DIVERGED_DOCUMENT_ID.to_string()]
        )
        .await,
        "the Rust copy holds every acknowledged write and drops the entry that only it wrote"
    );
    assert_eq!(successor.title(LEDGER, DIVERGED_DOCUMENT_ID).await, None);
    let difference = typescript_copy_difference(&mut successor, &written).await;
    assert!(difference.is_none(), "{difference:?}");

    departed.stop().await;
    successor.shutdown().await;
    cluster.stop().await;
}
