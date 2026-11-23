use narsil_cluster::coordinator::etcd::EtcdCoordinator;

use crate::data_node::{DataNode, Scratch, coordinator_at, etcd_endpoint, unique_key_prefix};
use crate::typescript_node::TypescriptNode;

const HERBARIUM: &str = "herbarium";
const FIRST_PARTITION_COUNT: u64 = 2;
const SECOND_PARTITION_COUNT: u64 = 4;
const HEARTBEAT_TTL_SECONDS: u64 = 30;
const SHEET_COUNT: usize = 30;

fn sheet_title(position: usize) -> String {
    format!("Mounted herbarium sheet {position}")
}

async fn served_partition_count(coordinator: &EtcdCoordinator) -> usize {
    let named = coordinator
        .allocation(HERBARIUM)
        .await
        .expect("etcd answers for the table")
        .expect("the index keeps a table under its name");
    let Some(generation) = named.generation else {
        return named.assignments.len();
    };
    coordinator
        .allocation(&generation)
        .await
        .expect("etcd answers for the generation's table")
        .map_or(0, |table| table.assignments.len())
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rust_node_moves_an_index_onto_a_new_partition_count_and_keeps_every_document() {
    let Some(endpoint) = etcd_endpoint() else {
        return;
    };
    let key_prefix = unique_key_prefix();
    let coordinator =
        coordinator_at(endpoint.clone(), key_prefix.clone(), HEARTBEAT_TTL_SECONDS).await;
    let controller =
        TypescriptNode::start(&endpoint, &key_prefix, "herbarium-controller", "controller").await;
    let mut press_a =
        TypescriptNode::start(&endpoint, &key_prefix, "herbarium-press-a", "data").await;
    let press_b = TypescriptNode::start(&endpoint, &key_prefix, "herbarium-press-b", "data").await;
    let curator_scratch = Scratch::new();
    let curator = DataNode::start_with_roles(
        &coordinator,
        "herbarium-curator",
        curator_scratch.path(),
        &["coordinator"],
    )
    .await;
    press_a
        .create_index(HERBARIUM, FIRST_PARTITION_COUNT, 0)
        .await;
    for position in 0..SHEET_COUNT {
        let answer = press_a
            .insert(
                HERBARIUM,
                &format!("sheet-{position}"),
                &sheet_title(position),
            )
            .await;
        assert_eq!(answer.code(), None);
    }

    for refused in [0, 65_537] {
        let error = curator
            .node
            .rebalance(HERBARIUM, refused)
            .await
            .expect_err("the node refuses a partition count outside the range");
        assert_eq!(error.code(), "CONFIG_INVALID");
    }
    let hidden = curator
        .node
        .rebalance("narsil-generation-herbarium", SECOND_PARTITION_COUNT)
        .await
        .expect_err("the node refuses a hidden generation's name");
    assert_eq!(hidden.code(), "CONFIG_INVALID");
    let missing = curator
        .node
        .rebalance("herbarium-that-was-never-made", SECOND_PARTITION_COUNT)
        .await
        .expect_err("the controller refuses an index that the cluster lacks");
    assert_eq!(missing.code(), "INDEX_NOT_FOUND");

    curator
        .node
        .rebalance(HERBARIUM, SECOND_PARTITION_COUNT)
        .await
        .expect("the partition count change finishes");
    assert_eq!(
        served_partition_count(&coordinator).await,
        SECOND_PARTITION_COUNT as usize
    );
    for position in 0..SHEET_COUNT {
        assert_eq!(
            press_a.title(HERBARIUM, &format!("sheet-{position}")).await,
            Some(sheet_title(position))
        );
    }
    let held: u64 = press_a
        .partition_counts(HERBARIUM)
        .await
        .iter()
        .map(|(_, count)| count)
        .sum();
    assert_eq!(held, SHEET_COUNT as u64);

    curator.stop().await;
    press_a.shutdown().await;
    press_b.shutdown().await;
    controller.shutdown().await;
    coordinator.shutdown().await;
}
