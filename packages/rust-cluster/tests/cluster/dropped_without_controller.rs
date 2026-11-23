use narsil::Value;
use narsil_cluster::transport::NodeTransport;

use crate::controller_lost_copy::start_controller;
use crate::data_node::{coordinator_at, etcd_endpoint, eventually, unique_key_prefix};
use crate::typescript_node::{TypescriptNode, fields};

const PRODUCTS: &str = "products";
const TYPESCRIPT_DATA_NODE: &str = "products-typescript-data";
const HEARTBEAT_TTL_SECONDS: u64 = 30;

#[tokio::test(flavor = "multi_thread")]
async fn a_rust_controller_that_starts_after_a_drop_tears_down_the_allocation_so_the_drop_finishes()
{
    let Some(endpoint) = etcd_endpoint() else {
        return;
    };
    let key_prefix = unique_key_prefix();
    let coordinator =
        coordinator_at(endpoint.clone(), key_prefix.clone(), HEARTBEAT_TTL_SECONDS).await;
    let first_controller = start_controller(&coordinator).await;
    let mut data = TypescriptNode::start(
        &endpoint,
        &key_prefix,
        TYPESCRIPT_DATA_NODE,
        "data,coordinator",
    )
    .await;
    data.create_index(PRODUCTS, 1, 0).await;
    first_controller.node.shutdown().await;
    first_controller.transport.shutdown().await;

    let drop_request = fields([("indexName", Value::from(PRODUCTS))]);
    let (dropped, second_controller) = tokio::join!(data.call("dropIndex", drop_request), async {
        eventually("the drop removes the schema", || async {
            coordinator
                .schema(PRODUCTS)
                .await
                .expect("etcd answers for the schema")
                .is_none()
        })
        .await;
        assert!(
            coordinator
                .allocation(PRODUCTS)
                .await
                .expect("etcd answers for the table")
                .is_some(),
            "no controller ran, so the dropped index keeps its allocation table"
        );
        start_controller(&coordinator).await
    });
    assert_eq!(
        dropped.code(),
        None,
        "the drop finishes once a controller starts"
    );
    assert!(
        coordinator
            .list_allocations()
            .await
            .expect("etcd lists the tables")
            .is_empty()
    );

    data.shutdown().await;
    second_controller.node.shutdown().await;
    second_controller.transport.shutdown().await;
    coordinator.shutdown().await;
}
