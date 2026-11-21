use narsil_cluster::coordinator::etcd::{EtcdCoordinator, EtcdCoordinatorConfig};

#[tokio::test]
async fn cancelled_watch_creation_releases_its_capacity() {
    let Ok(endpoint) = std::env::var("NARSIL_ETCD_ENDPOINT") else {
        return;
    };
    if endpoint.is_empty() {
        return;
    }
    let coordinator = EtcdCoordinator::connect(EtcdCoordinatorConfig {
        endpoints: vec![endpoint],
        key_prefix: "_narsil_rust_cancelled_watch".to_string(),
        ..EtcdCoordinatorConfig::default()
    })
    .await
    .expect("the coordinator connects");
    for _ in 0..64 {
        tokio::select! {
            biased;
            _ = coordinator.watch_nodes(|_| {}) => panic!("watch creation completed before its first network wait"),
            () = std::future::ready(()) => {}
        }
    }
    let watch = coordinator
        .watch_nodes(|_| {})
        .await
        .expect("cancelled watches leave room for a new watch");
    watch.stop();
    coordinator.shutdown().await;
}
