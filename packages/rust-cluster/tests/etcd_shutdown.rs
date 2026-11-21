use std::time::{SystemTime, UNIX_EPOCH};

use etcd_client::{Client, GetOptions};
use narsil::Map;
use narsil_cluster::SPEC_VERSION;
use narsil_cluster::coordinator::etcd::{EtcdCoordinator, EtcdCoordinatorConfig};
use narsil_cluster::coordinator::{NodeCapacity, NodeRegistration};

#[tokio::test]
async fn shutdown_revokes_registrations_and_leases_that_are_being_acquired() {
    let Ok(endpoint) = std::env::var("NARSIL_ETCD_ENDPOINT") else {
        return;
    };
    if endpoint.is_empty() {
        return;
    }
    let mut raw = Client::connect([endpoint.clone()], None)
        .await
        .expect("etcd is reachable");
    for registration in [true, false] {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("the clock is set")
            .as_nanos();
        let prefix = format!("_narsil_rust_shutdown_{nanos}");
        let coordinator = EtcdCoordinator::connect(EtcdCoordinatorConfig {
            endpoints: vec![endpoint.clone()],
            key_prefix: prefix.clone(),
            ..EtcdCoordinatorConfig::default()
        })
        .await
        .expect("the coordinator connects");
        let joining = async {
            if registration {
                coordinator
                    .register_node(&NodeRegistration {
                        node_id: "joining".to_string(),
                        address: "127.0.0.1:9300".to_string(),
                        roles: vec!["coordinator".to_string()],
                        capacity: NodeCapacity::default(),
                        started_at: "2026-11-21T00:00:00.000Z".to_string(),
                        version: SPEC_VERSION.to_string(),
                        extra: Map::new(),
                    })
                    .await
            } else {
                coordinator
                    .acquire_lease("controller", "joining", 30_000)
                    .await
                    .map(|_| ())
            }
        };
        let (_, ()) = tokio::join!(biased; joining, coordinator.shutdown());
        let remaining = raw
            .get(format!("{prefix}/"), Some(GetOptions::new().with_prefix()))
            .await
            .expect("etcd lists the keys");
        assert!(
            remaining.kvs().is_empty(),
            "a lease acquired during shutdown retained its keys"
        );
    }
}
