use narsil::Map;
use narsil_cluster::SPEC_VERSION;
use narsil_cluster::coordinator::etcd::{EtcdCoordinator, EtcdCoordinatorConfig};
use narsil_cluster::coordinator::{NodeCapacity, NodeRegistration};
use narsil_cluster::error::codes;

#[tokio::test]
async fn an_unrepresentable_lease_lifetime_returns_an_error_without_panicking() {
    let Ok(endpoint) = std::env::var("NARSIL_ETCD_ENDPOINT") else {
        return;
    };
    if endpoint.is_empty() {
        return;
    }
    let coordinator = EtcdCoordinator::connect(EtcdCoordinatorConfig {
        endpoints: vec![endpoint],
        key_prefix: "_narsil_rust_lease_lifetime".to_string(),
        node_heartbeat_ttl_seconds: u64::MAX,
        ..EtcdCoordinatorConfig::default()
    })
    .await
    .expect("the coordinator connects");
    let error = coordinator
        .register_node(&NodeRegistration {
            node_id: "invalid-lifetime".to_string(),
            address: "127.0.0.1:9300".to_string(),
            roles: vec!["coordinator".to_string()],
            capacity: NodeCapacity::default(),
            started_at: "2026-11-21T00:00:00.000Z".to_string(),
            version: SPEC_VERSION.to_string(),
            extra: Map::new(),
        })
        .await
        .expect_err("the lifetime is refused");
    assert_eq!(error.code(), codes::CONFIG_INVALID);
    coordinator.shutdown().await;
}
