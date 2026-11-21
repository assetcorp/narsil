use std::time::{SystemTime, UNIX_EPOCH};

use narsil_cluster::coordinator::etcd::{EtcdCoordinator, EtcdCoordinatorConfig};

#[tokio::test]
async fn an_empty_expected_value_requires_an_existing_empty_record() {
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
    let coordinator = EtcdCoordinator::connect(EtcdCoordinatorConfig {
        endpoints: vec![endpoint],
        key_prefix: format!("_narsil_rust_cas_{nanos}"),
        ..EtcdCoordinatorConfig::default()
    })
    .await
    .expect("the coordinator connects");

    assert!(
        !coordinator
            .compare_and_set("record", Some(&[]), b"replacement")
            .await
            .expect("the comparison completes")
    );
    assert_eq!(
        coordinator.get("record").await.expect("the record is read"),
        None
    );
    assert!(
        coordinator
            .compare_and_set("record", None, &[])
            .await
            .expect("the empty value is created")
    );
    assert!(
        coordinator
            .compare_and_set("record", Some(&[]), b"replacement")
            .await
            .expect("the empty value is replaced")
    );
    assert_eq!(
        coordinator.get("record").await.expect("the record is read"),
        Some(b"replacement".to_vec())
    );

    coordinator
        .delete("record")
        .await
        .expect("the test removes its record");
    coordinator.shutdown().await;
}
