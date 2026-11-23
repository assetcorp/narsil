use std::collections::BTreeSet;

use narsil::{Map, Value};
use narsil_cluster::coordinator::etcd::EtcdCoordinatorConfig;

use crate::data_node::{DataNode, Scratch, coordinator_at, etcd_endpoint, unique_key_prefix};
use crate::ledger::start_controller;
use crate::spread::{fnv1a_partition, settled_holders};
use crate::typescript_node::{TypescriptNode, fields};

const INDEX: &str = "mixed-harbour";
const PARTITIONS: u32 = 3;
const REPLICATION_FACTOR: u64 = 1;
const SHARED_TITLE: &str = "harbour lights";
const FILLER_DOCUMENTS: usize = 30;
const SCORE_RELATIVE_TOLERANCE: f64 = 1e-9;

fn ids_in_partition(prefix: &str, partition_id: u32, wanted: usize) -> Vec<String> {
    (0..)
        .map(|serial| format!("{prefix}-{serial}"))
        .filter(|id| fnv1a_partition(id, PARTITIONS) == partition_id)
        .take(wanted)
        .collect()
}

fn query_params(term: &str, scoring: &str) -> Value {
    Value::Object(fields([
        ("term", Value::from(term)),
        ("scoring", Value::from(scoring)),
        ("limit", Value::from(50u64)),
    ]))
}

async fn search(node: &mut TypescriptNode, params: Value) -> Map {
    let answer = node
        .call(
            "query",
            fields([("indexName", Value::from(INDEX)), ("params", params)]),
        )
        .await
        .value();
    match answer {
        Value::Object(result) => result,
        other => panic!("the TypeScript node returns a query result: {other:?}"),
    }
}

fn hit_scores(result: &Map) -> Vec<(String, f64)> {
    let Some(Value::Array(hits)) = result.get("hits") else {
        panic!("the query result lists its hits: {result:?}");
    };
    hits.iter()
        .map(|hit| {
            let hit = hit.as_object().expect("each hit is an object");
            let id = hit
                .get("id")
                .and_then(Value::as_str)
                .expect("each hit has an id");
            let score = match hit.get("score") {
                Some(Value::Number(score)) => *score,
                other => panic!("an unsorted hit carries its score: {other:?}"),
            };
            (id.to_string(), score)
        })
        .collect()
}

fn whole_number(value: Option<&Value>) -> u64 {
    match value {
        Some(Value::Number(number)) if number.fract() == 0.0 && *number >= 0.0 => *number as u64,
        other => panic!("expected a whole number: {other:?}"),
    }
}

fn scores_agree(left: f64, right: f64) -> bool {
    (left - right).abs() <= SCORE_RELATIVE_TOLERANCE * left.abs().max(right.abs())
}

#[tokio::test(flavor = "multi_thread")]
async fn a_typescript_coordinator_reads_rust_data_nodes_as_one_index() {
    let Some(endpoint) = etcd_endpoint() else {
        return;
    };
    let key_prefix = unique_key_prefix();
    let ttl = EtcdCoordinatorConfig::default().node_heartbeat_ttl_seconds;
    let coordinator = coordinator_at(endpoint.clone(), key_prefix.clone(), ttl).await;
    let controller_scratch = Scratch::new();
    let controller = start_controller(&coordinator, &controller_scratch).await;
    let scratches = [Scratch::new(), Scratch::new(), Scratch::new()];
    let mut nodes = Vec::new();
    for (node_id, scratch) in ["query-rust-a", "query-rust-b", "query-rust-c"]
        .into_iter()
        .zip(&scratches)
    {
        nodes.push(DataNode::start(&coordinator, node_id, scratch.path()).await);
    }
    let mut reader = TypescriptNode::start(
        &endpoint,
        &key_prefix,
        "query-ts-coordinator",
        "coordinator",
    )
    .await;
    reader
        .create_index(INDEX, u64::from(PARTITIONS), REPLICATION_FACTOR)
        .await;
    settled_holders(&coordinator, INDEX, PARTITIONS).await;

    let shared_ids: Vec<String> = (0..PARTITIONS)
        .flat_map(|partition_id| ids_in_partition("shared", partition_id, 1))
        .collect();
    for id in &shared_ids {
        reader.insert(INDEX, id, SHARED_TITLE).await.value();
    }
    let mut stored: BTreeSet<String> = shared_ids.iter().cloned().collect();
    for id in ids_in_partition("filler", 0, FILLER_DOCUMENTS) {
        reader
            .insert(INDEX, &id, "quiet inland meadow without any water at all")
            .await
            .value();
        stored.insert(id);
    }
    let harbour_ids: BTreeSet<String> = shared_ids.iter().cloned().collect();

    let counted = reader
        .call(
            "countDocuments",
            fields([("indexName", Value::from(INDEX))]),
        )
        .await
        .value();
    assert_eq!(whole_number(Some(&counted)), stored.len() as u64);

    let dfs = search(&mut reader, query_params("harbour", "dfs")).await;
    let dfs_scores = hit_scores(&dfs);
    let found: BTreeSet<String> = dfs_scores.iter().map(|(id, _)| id.clone()).collect();
    assert_eq!(found, harbour_ids, "{dfs:?}");
    assert_eq!(whole_number(dfs.get("count")), harbour_ids.len() as u64);
    let coverage = dfs
        .get("coverage")
        .and_then(Value::as_object)
        .expect("the result reports its coverage");
    assert_eq!(
        whole_number(coverage.get("totalPartitions")),
        u64::from(PARTITIONS)
    );
    assert_eq!(
        whole_number(coverage.get("queriedPartitions")),
        u64::from(PARTITIONS)
    );
    assert_eq!(whole_number(coverage.get("failedPartitions")), 0);
    let first = dfs_scores[0].1;
    assert!(
        dfs_scores
            .iter()
            .all(|(_, score)| scores_agree(*score, first)),
        "DFS scores the same text the same in every partition: {dfs_scores:?}"
    );

    let local_scores = hit_scores(&search(&mut reader, query_params("harbour", "local")).await);
    let local_first = local_scores[0].1;
    assert!(
        local_scores
            .iter()
            .any(|(_, score)| !scores_agree(*score, local_first)),
        "the partitions differ enough that only global statistics make the scores agree: {local_scores:?}"
    );

    let suggested = reader
        .call(
            "suggest",
            fields([
                ("indexName", Value::from(INDEX)),
                (
                    "params",
                    Value::Object(fields([("prefix", Value::from("harb"))])),
                ),
            ]),
        )
        .await
        .value();
    let terms = suggested
        .as_object()
        .and_then(|result| result.get("terms"))
        .and_then(Value::as_array)
        .expect("the suggest result lists its terms");
    let harbour = terms
        .iter()
        .filter_map(Value::as_object)
        .find(|term| term.get("term").and_then(Value::as_str) == Some("harbour"))
        .expect("the suggestions complete the prefix to harbour");
    assert_eq!(
        whole_number(harbour.get("documentFrequency")),
        harbour_ids.len() as u64
    );

    let preflight = reader
        .call(
            "preflight",
            fields([
                ("indexName", Value::from(INDEX)),
                (
                    "params",
                    Value::Object(fields([("term", Value::from("meadow"))])),
                ),
            ]),
        )
        .await
        .value();
    assert_eq!(
        whole_number(preflight.as_object().and_then(|result| result.get("count"))),
        FILLER_DOCUMENTS as u64
    );

    let listed = reader
        .call(
            "listDocuments",
            fields([
                ("indexName", Value::from(INDEX)),
                (
                    "params",
                    Value::Object(fields([("limit", Value::from(1_000u64))])),
                ),
            ]),
        )
        .await
        .value();
    let listed = listed.as_object().expect("the listing is an object");
    let listed_ids: Vec<String> = listed
        .get("ids")
        .and_then(Value::as_array)
        .expect("the listing names its documents")
        .iter()
        .filter_map(|id| id.as_str().map(str::to_string))
        .collect();
    let mut code_point_order: Vec<String> = stored.iter().cloned().collect();
    code_point_order.sort();
    assert_eq!(listed_ids, code_point_order);
    assert_eq!(whole_number(listed.get("total")), stored.len() as u64);

    for id in &shared_ids {
        let fetched = reader
            .call(
                "get",
                fields([
                    ("indexName", Value::from(INDEX)),
                    ("documentId", Value::from(id.as_str())),
                ]),
            )
            .await
            .value();
        assert_eq!(
            fetched
                .as_object()
                .and_then(|document| document.get("title"))
                .and_then(Value::as_str),
            Some(SHARED_TITLE)
        );
    }

    reader.shutdown().await;
    for node in nodes {
        node.stop().await;
    }
    controller.stop().await;
    coordinator.shutdown().await;
}
