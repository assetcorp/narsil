use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use etcd_client::{Client, DeleteOptions, Txn, TxnOp};
use narsil_cluster::coordinator::etcd::{EtcdCoordinator, EtcdCoordinatorConfig, WatchHandle};
use tokio::sync::mpsc;

#[tokio::test]
async fn stopping_a_watch_in_its_handler_stops_the_rest_of_the_transaction() {
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
    let prefix = format!("_narsil_rust_watch_stop_{nanos}");
    let coordinator = EtcdCoordinator::connect(EtcdCoordinatorConfig {
        endpoints: vec![endpoint.clone()],
        key_prefix: prefix.clone(),
        ..EtcdCoordinatorConfig::default()
    })
    .await
    .expect("the coordinator connects");
    let (sent, mut received) = mpsc::unbounded_channel();
    let handle: Arc<Mutex<Option<WatchHandle>>> = Arc::new(Mutex::new(None));
    let stopping = Arc::clone(&handle);
    let watch = coordinator
        .watch_schemas(move |event| {
            if let Some(watch) = stopping.lock().expect("the handle is available").take() {
                watch.stop();
            }
            sent.send(event).expect("the test receives events");
        })
        .await
        .expect("the watch starts");
    *handle.lock().expect("the handle is available") = Some(watch);
    let mut raw = Client::connect([endpoint], None)
        .await
        .expect("etcd is reachable");
    raw.txn(Txn::new().and_then(vec![
        TxnOp::put(format!("{prefix}/schema/first"), vec![0x80], None),
        TxnOp::put(format!("{prefix}/schema/second"), vec![0x80], None),
    ]))
    .await
    .expect("the transaction completes");
    tokio::time::timeout(Duration::from_secs(5), received.recv())
        .await
        .expect("the first event arrives")
        .expect("the watch emits an event");
    assert!(
        tokio::time::timeout(Duration::from_secs(5), received.recv())
            .await
            .expect("the stopped watch releases its callback")
            .is_none()
    );
    coordinator.shutdown().await;
    raw.delete(
        format!("{prefix}/"),
        Some(DeleteOptions::new().with_prefix()),
    )
    .await
    .expect("the test removes its records");
}
