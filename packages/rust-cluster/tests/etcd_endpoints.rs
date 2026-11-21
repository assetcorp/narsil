use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use narsil::Map;
use narsil_cluster::SPEC_VERSION;
use narsil_cluster::coordinator::etcd::{EtcdCoordinator, EtcdCoordinatorConfig};
use narsil_cluster::coordinator::{NodeCapacity, NodeRegistration};
use narsil_cluster::node::next_started_at;
use tokio::net::TcpListener;

const ETCD_ENDPOINT_VARIABLE: &str = "NARSIL_ETCD_ENDPOINT";
const SLOW_CALL: Duration = Duration::from_secs(2);
const FAST_CALL: Duration = Duration::from_secs(1);
const LONGEST_CALL: Duration = Duration::from_secs(8);
const FAILURES_THAT_OPEN_THE_BREAKER: usize = 3;
const CALLS_BEFORE_GIVING_UP: usize = 40;
const CALLS_WHILE_SKIPPED: usize = 20;

fn live_endpoint() -> Option<String> {
    std::env::var(ETCD_ENDPOINT_VARIABLE)
        .ok()
        .filter(|endpoint| !endpoint.is_empty())
}

async fn hung_endpoint() -> String {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("the test binds a port");
    let address = listener.local_addr().expect("the listener has an address");
    tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((socket, _)) = listener.accept().await {
            held.push(socket);
        }
    });
    format!("http://{address}")
}

fn registration(node_id: &str) -> NodeRegistration {
    NodeRegistration {
        node_id: node_id.to_string(),
        address: "127.0.0.1:9300".to_string(),
        roles: vec!["coordinator".to_string()],
        capacity: NodeCapacity::default(),
        started_at: next_started_at(),
        version: SPEC_VERSION.to_string(),
        extra: Map::new(),
    }
}

fn unique(prefix: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    format!("{prefix}-{nanos}")
}

async fn listed_ids(coordinator: &EtcdCoordinator) -> (Vec<String>, Duration) {
    let started = Instant::now();
    let nodes = coordinator
        .list_nodes()
        .await
        .expect("a hung endpoint never fails a call that a live one can serve");
    (
        nodes.into_iter().map(|node| node.node_id).collect(),
        started.elapsed(),
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn a_hung_etcd_endpoint_is_skipped_once_it_fails_three_calls() {
    let Some(live) = live_endpoint() else {
        eprintln!("{ETCD_ENDPOINT_VARIABLE} is unset, so the etcd endpoint test does not start");
        return;
    };
    let coordinator = EtcdCoordinator::connect(EtcdCoordinatorConfig {
        endpoints: vec![hung_endpoint().await, live],
        key_prefix: unique("_narsil_rust_endpoints"),
        node_heartbeat_ttl_seconds: 10,
        ..EtcdCoordinatorConfig::default()
    })
    .await
    .expect("the coordinator connects through the live endpoint");
    let node_id = unique("endpoint-node");
    coordinator
        .register_node(&registration(&node_id))
        .await
        .expect("the node registers through the live endpoint");

    let mut slow_calls = 0;
    let mut fast_in_a_row = 0;
    for _ in 0..CALLS_BEFORE_GIVING_UP {
        let (ids, took) = listed_ids(&coordinator).await;
        assert_eq!(ids, std::slice::from_ref(&node_id));
        assert!(took < LONGEST_CALL, "one call waited {took:?}");
        if took >= SLOW_CALL {
            slow_calls += 1;
            fast_in_a_row = 0;
        } else if took < FAST_CALL {
            fast_in_a_row += 1;
        }
        if fast_in_a_row == CALLS_WHILE_SKIPPED {
            break;
        }
    }
    assert_eq!(
        fast_in_a_row, CALLS_WHILE_SKIPPED,
        "the client never skipped the hung endpoint"
    );
    assert!(
        slow_calls <= FAILURES_THAT_OPEN_THE_BREAKER,
        "{slow_calls} calls waited on the hung endpoint"
    );

    coordinator
        .deregister_node(&node_id)
        .await
        .expect("the node deregisters");
    let (ids, _) = listed_ids(&coordinator).await;
    assert!(ids.is_empty(), "{ids:?}");
    coordinator.shutdown().await;
}
