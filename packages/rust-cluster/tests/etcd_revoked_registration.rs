use std::time::{SystemTime, UNIX_EPOCH};

use etcd_client::Client;
use narsil::Map;
use narsil_cluster::SPEC_VERSION;
use narsil_cluster::coordinator::etcd::{EtcdCoordinator, EtcdCoordinatorConfig};
use narsil_cluster::coordinator::{NodeCapacity, NodeRegistration};

#[tokio::test]
async fn confirming_a_revoked_registration_reports_no_remaining_lease() {
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
    let prefix = format!("_narsil_rust_revoked_{nanos}");
    let coordinator = EtcdCoordinator::connect(EtcdCoordinatorConfig {
        endpoints: vec![endpoint.clone()],
        key_prefix: prefix.clone(),
        ..EtcdCoordinatorConfig::default()
    })
    .await
    .expect("the coordinator connects");
    coordinator
        .register_node(&NodeRegistration {
            node_id: "revoked".to_string(),
            address: "127.0.0.1:9300".to_string(),
            roles: vec!["coordinator".to_string()],
            capacity: NodeCapacity::default(),
            started_at: "2026-11-21T00:00:00.000Z".to_string(),
            version: SPEC_VERSION.to_string(),
            extra: Map::new(),
        })
        .await
        .expect("the node registers");
    let mut raw = Client::connect([endpoint], None)
        .await
        .expect("etcd is reachable");
    let record = raw
        .get(format!("{prefix}/nodes/revoked"), None)
        .await
        .expect("etcd returns the registration");
    let lease = record
        .kvs()
        .first()
        .expect("the registration exists")
        .lease();
    raw.lease_revoke(lease)
        .await
        .expect("etcd revokes the lease");

    assert_eq!(
        coordinator.confirm_registration_lease("revoked").await,
        None
    );

    coordinator.shutdown().await;
}
