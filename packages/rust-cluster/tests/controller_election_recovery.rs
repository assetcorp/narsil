use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use narsil::{Map, Value};
use narsil_cluster::SPEC_VERSION;
use narsil_cluster::coordinator::etcd::{EtcdCoordinator, EtcdCoordinatorConfig};
use narsil_cluster::coordinator::{NodeCapacity, NodeRegistration};
use narsil_cluster::message::TransportMessage;
use narsil_cluster::node::{ClusterNode, ClusterNodeConfig};
use narsil_cluster::transport::NodeTransport;
use narsil_cluster::transport::tcp::{TcpTransport, TcpTransportConfig};
use tokio::sync::mpsc;

mod support;

const CONTROLLER_KEY: &str = "_narsil/controller";
const WATCH_LIMIT: usize = 64;
const STANDBY_RETRY_MS: u64 = 100;
const WAIT: Duration = Duration::from_secs(10);

#[tokio::test]
async fn a_panicking_error_callback_does_not_abandon_controller_election() {
    let Ok(endpoint) = std::env::var("NARSIL_ETCD_ENDPOINT") else {
        return;
    };
    if endpoint.is_empty() {
        return;
    }
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("the clock is set")
        .as_nanos();
    let config = EtcdCoordinatorConfig {
        endpoints: vec![endpoint],
        key_prefix: format!("_narsil_election_callback_{nanos}"),
        ..EtcdCoordinatorConfig::default()
    };
    let holder = EtcdCoordinator::connect(config.clone())
        .await
        .expect("the current controller connects");
    assert!(
        holder
            .acquire_lease(CONTROLLER_KEY, "previous-controller", 30_000)
            .await
            .expect("the current controller takes the lease")
    );
    let coordinator = Arc::new(
        EtcdCoordinator::connect(config)
            .await
            .expect("the standby controller connects"),
    );
    let transport = Arc::new(
        TcpTransport::new(
            "standby-controller",
            TcpTransportConfig {
                host: "127.0.0.1".to_string(),
                port: 0,
                ..TcpTransportConfig::default()
            },
        )
        .expect("the transport is valid"),
    );
    let mut settings = ClusterNodeConfig::new(
        Arc::clone(&coordinator),
        transport.clone(),
        NodeRegistration {
            node_id: "standby-controller".to_string(),
            address: "127.0.0.1:9300".to_string(),
            roles: vec!["controller".to_string()],
            capacity: NodeCapacity::default(),
            started_at: "2026-11-21T00:00:00.000Z".to_string(),
            version: SPEC_VERSION.to_string(),
            extra: Map::new(),
        },
    );
    settings.controller.standby_retry_ms = STANDBY_RETRY_MS;
    let (errors, mut received) = mpsc::unbounded_channel();
    settings.on_error = Some(Arc::new(move |error| {
        let _ = errors.send(error.code().to_string());
        panic!("the application's error reporter failed");
    }));
    let node = ClusterNode::new(settings).expect("the node settings are valid");
    node.start().await.expect("the node joins as a standby");
    let mut watches = Vec::new();
    let refusal = loop {
        assert!(
            watches.len() < WATCH_LIMIT,
            "the coordinator opens more than {WATCH_LIMIT} watches"
        );
        match coordinator.watch_nodes(|_| {}).await {
            Ok(watch) => watches.push(watch),
            Err(refusal) => break refusal,
        }
    };
    assert_eq!(refusal.code(), "CONFIG_INVALID");
    assert_eq!(
        refusal.details().get("currentCount"),
        Some(&Value::from(WATCH_LIMIT as f64)),
        "{refusal:?}"
    );
    assert!(
        !watches.is_empty(),
        "the application fills at least one of the coordinator's watch slots"
    );
    holder
        .release_lease(CONTROLLER_KEY)
        .await
        .expect("the previous controller releases the lease");
    assert_eq!(
        tokio::time::timeout(WAIT, received.recv())
            .await
            .expect("the failed election reaches the error callback")
            .as_deref(),
        Some("CONFIG_INVALID")
    );
    for watch in watches {
        watch.stop();
    }
    let target = format!("127.0.0.1:{}", transport.port());
    let recovered = tokio::time::timeout(WAIT, async {
        loop {
            let answer = transport
                .send(
                    &target,
                    TransportMessage::new("cluster.rebalance", "requester", "probe", vec![0x80]),
                )
                .await
                .expect("the controller listener answers");
            if support::decode(&answer.payload).text("code") == "CLUSTER_OPERATION_UNSUPPORTED" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(STANDBY_RETRY_MS)).await;
        }
    })
    .await;
    let elected = holder.lease_holder(CONTROLLER_KEY).await;
    node.shutdown().await;
    transport.shutdown().await;
    coordinator.shutdown().await;
    holder.shutdown().await;
    recovered.expect("the standby retries and starts serving after watch slots become available");
    assert_eq!(
        elected.expect("etcd returns the holder").as_deref(),
        Some("standby-controller")
    );
}
