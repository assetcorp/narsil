use narsil::Value;
use narsil_cluster::coordinator::etcd::EtcdCoordinator;

use crate::data_node::{
    DataNode, Scratch, coordinator_at, etcd_endpoint, eventually, unique_key_prefix,
};
use crate::typescript_node::{Answer, TypescriptNode, fields};

const SURVEY: &str = "botanical-survey";
const FIRST_PARTITION_COUNT: u64 = 3;
const SEEDED_PLOTS: usize = 60;
const CONTROLLER: &str = "survey-controller";
const STATION_A: &str = "survey-station-a";
const STATION_B: &str = "survey-station-b";
const HEARTBEAT_TTL_SECONDS: u64 = 30;
const HIDDEN_GENERATION_PREFIX: &str = "narsil-generation-";

fn plot_title(sequence: usize) -> String {
    format!("meadow plot {sequence} with sedge")
}

async fn rebalance(router: &mut TypescriptNode, index_name: &str, target: f64) -> Answer {
    router
        .call(
            "rebalance",
            fields([
                ("indexName", Value::from(index_name)),
                ("targetPartitionCount", Value::from(target)),
            ]),
        )
        .await
}

async fn hidden_layouts(coordinator: &EtcdCoordinator) -> Vec<String> {
    coordinator
        .list_schemas()
        .await
        .expect("etcd lists the schemas")
        .into_iter()
        .filter(|name| name.starts_with(HIDDEN_GENERATION_PREFIX))
        .collect()
}

async fn serving_layout(coordinator: &EtcdCoordinator) -> Option<String> {
    coordinator
        .allocation(SURVEY)
        .await
        .expect("etcd answers for the table")
        .and_then(|table| table.generation)
}

async fn expect_matches_oracle(router: &mut TypescriptNode, partition_count: usize) {
    let counts = router.partition_counts(SURVEY).await;
    assert_eq!(counts.len(), partition_count, "{counts:?}");
    assert_eq!(
        counts.iter().map(|(_, count)| *count).sum::<u64>(),
        SEEDED_PLOTS as u64,
        "{counts:?}"
    );
    for sequence in 0..SEEDED_PLOTS {
        let held = router.title(SURVEY, &format!("plot-{sequence}")).await;
        assert_eq!(held, Some(plot_title(sequence)));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rust_controller_changes_the_count_twice_and_drops_the_layout_that_the_first_change_built()
 {
    let Some(endpoint) = etcd_endpoint() else {
        return;
    };
    let key_prefix = unique_key_prefix();
    let coordinator =
        coordinator_at(endpoint.clone(), key_prefix.clone(), HEARTBEAT_TTL_SECONDS).await;
    let controller_scratch = Scratch::new();
    let controller = DataNode::start_configured(
        &coordinator,
        CONTROLLER,
        controller_scratch.path(),
        &["controller"],
        |settings| settings.controller.node_left_delay_ms = 0,
    )
    .await;
    let mut router =
        TypescriptNode::start(&endpoint, &key_prefix, STATION_A, "data,coordinator").await;
    let station_b = TypescriptNode::start(&endpoint, &key_prefix, STATION_B, "data").await;
    router.create_index(SURVEY, FIRST_PARTITION_COUNT, 1).await;
    for sequence in 0..SEEDED_PLOTS {
        let answer = router
            .insert(SURVEY, &format!("plot-{sequence}"), &plot_title(sequence))
            .await;
        assert_eq!(answer.code(), None);
    }

    assert_eq!(rebalance(&mut router, SURVEY, 6.0).await.code(), None);
    let first_layout = serving_layout(&coordinator)
        .await
        .expect("the first change serves the index from a hidden layout");
    assert_eq!(rebalance(&mut router, SURVEY, 2.0).await.code(), None);
    expect_matches_oracle(&mut router, 2).await;
    eventually("the first layout is dropped", || async {
        !hidden_layouts(&coordinator).await.contains(&first_layout)
    })
    .await;
    assert_eq!(
        hidden_layouts(&coordinator).await,
        vec![
            serving_layout(&coordinator)
                .await
                .expect("the second change serves the index from a hidden layout")
        ]
    );

    router.shutdown().await;
    station_b.shutdown().await;
    controller.stop().await;
    coordinator.shutdown().await;
}
