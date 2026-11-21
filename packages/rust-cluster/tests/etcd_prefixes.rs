use std::time::{Duration, SystemTime, UNIX_EPOCH};

use etcd_client::{Client, DeleteOptions, Txn, TxnOp};
use narsil_cluster::coordinator::SchemaEvent;
use narsil_cluster::coordinator::etcd::{EtcdCoordinator, EtcdCoordinatorConfig};
use tokio::sync::mpsc;

#[tokio::test]
async fn listings_and_watches_exclude_keys_outside_the_record_directory() {
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
    let prefix = format!("_narsil_rust_prefixes_{nanos}");
    let coordinator = EtcdCoordinator::connect(EtcdCoordinatorConfig {
        endpoints: vec![endpoint.clone()],
        key_prefix: prefix.clone(),
        ..EtcdCoordinatorConfig::default()
    })
    .await
    .expect("the coordinator connects");
    let mut raw = Client::connect([endpoint], None)
        .await
        .expect("etcd is reachable");
    raw.put(format!("{prefix}/nodes-backup/other"), vec![0xc1], None)
        .await
        .expect("the sibling key is written");
    assert!(
        coordinator
            .list_nodes()
            .await
            .expect("the listing reads only registrations")
            .is_empty()
    );

    let (sent, mut received) = mpsc::unbounded_channel();
    let watch = coordinator
        .watch_schemas(move |event| {
            sent.send(event).expect("the test receives events");
        })
        .await
        .expect("the watch starts");
    raw.txn(Txn::new().and_then(vec![
        TxnOp::put(format!("{prefix}/schema-backup/other"), vec![0x80], None),
        TxnOp::put(format!("{prefix}/schema/catalogue"), vec![0x80], None),
    ]))
    .await
    .expect("the schemas are written");
    let event = tokio::time::timeout(Duration::from_secs(5), received.recv())
        .await
        .expect("the watch answers")
        .expect("the watch sends the schema");
    assert!(matches!(event, SchemaEvent::Created { index_name, .. } if index_name == "catalogue"));
    assert_eq!(
        coordinator
            .list_schemas()
            .await
            .expect("the schemas are listed"),
        ["catalogue"]
    );
    watch.stop();
    coordinator.shutdown().await;
    raw.delete(
        format!("{prefix}/"),
        Some(DeleteOptions::new().with_prefix()),
    )
    .await
    .expect("the test removes its records");
}
