use std::collections::BTreeMap;

use std::sync::Arc;

use narsil::{
    AdapterError, DocumentProjection, FacetSpec, GroupConfig, GroupReducer, ListParams, Map, Pin,
    QueryParams, QueryResult, RerankAdapter, RerankConfig, ScoringMode, SortDirection, SortField,
    SuggestParams, Value,
};
use narsil_cluster::coordinator::etcd::{EtcdCoordinator, EtcdCoordinatorConfig};
use narsil_cluster::error::codes;
use narsil_cluster::node::{ClusterNode, ClusterNodeConfig};

use crate::data_node::{
    DataNode, Scratch, coordinator_at, etcd_endpoint, eventually, unique_key_prefix,
};
use crate::ledger::start_controller;
use crate::spread::fnv1a_partition;
use crate::typescript_node::{TypescriptNode, fields};

const INDEX: &str = "mixed-shop";
const PARTITIONS: u32 = 4;
const DOCUMENT_TOTAL: usize = 24;
const PAGE_SIZE: usize = 5;
const SORTED_PAGE_SIZE: usize = 7;
const PAGE_BUDGET: usize = 10;
const MAX_PAGE_SIZE: usize = 10_000;
const ROUTER_ID: &str = "mixed-reads-rust-router";
const HOLDER_IDS: [&str; 2] = ["mixed-reads-ts-holder-1", "mixed-reads-ts-holder-2"];

struct ShopDocument {
    id: String,
    title: String,
    price: f64,
    category: &'static str,
}

fn shop_documents() -> Vec<ShopDocument> {
    (0..DOCUMENT_TOTAL)
        .map(|index| ShopDocument {
            id: format!("item-{index}"),
            title: format!("Portable Grinder {index}"),
            price: index as f64,
            category: if index % 3 == 0 {
                "kitchen"
            } else {
                "workshop"
            },
        })
        .collect()
}

fn stored_form(document: &ShopDocument) -> Map {
    fields([
        ("title", Value::from(document.title.as_str())),
        ("price", Value::from(document.price)),
        ("category", Value::from(document.category)),
    ])
}

fn written_form(document: &ShopDocument) -> Value {
    let mut written = stored_form(document);
    written.insert("id", Value::from(document.id.as_str()));
    Value::Object(written)
}

fn kitchen_filter() -> Value {
    let category = fields([("eq", Value::from("kitchen"))]);
    let tested = fields([("category", Value::Object(category))]);
    Value::Object(fields([("fields", Value::Object(tested))]))
}

fn grinder_query(filters: Option<Value>) -> QueryParams {
    QueryParams {
        term: Some("grinder".to_string()),
        filters,
        ..QueryParams::default()
    }
}

type GroupShape = (Vec<(String, Option<Value>)>, Vec<String>, Option<Value>);

const TRAILING_NUMBER_RERANKER: &str = "trailing-number";

struct TrailingNumber;

impl RerankAdapter for TrailingNumber {
    fn score(&self, _query: &str, documents: &[String]) -> Result<Vec<f64>, AdapterError> {
        Ok(documents
            .iter()
            .map(|text| {
                text.rsplit(' ')
                    .next()
                    .and_then(|number| number.parse::<f64>().ok())
                    .unwrap_or(-1.0)
            })
            .collect())
    }
}

fn with_trailing_number_reranker(config: &mut ClusterNodeConfig) {
    if let Some(data) = config.data.as_mut() {
        data.rerank_adapters.insert(
            TRAILING_NUMBER_RERANKER.to_string(),
            Arc::new(TrailingNumber),
        );
    }
}

fn dfs_grinder_query(limit: usize) -> QueryParams {
    QueryParams {
        scoring: Some(ScoringMode::Dfs),
        limit: Some(limit),
        ..grinder_query(None)
    }
}

fn hit_ids(result: &QueryResult) -> Vec<String> {
    result.hits.iter().map(|hit| hit.id.clone()).collect()
}

fn price_of(document: &Map) -> f64 {
    match document.get("price") {
        Some(Value::Number(price)) => *price,
        _ => 0.0,
    }
}

fn price_sum() -> GroupReducer {
    GroupReducer {
        reducer: Arc::new(|sum: Value, document: &Map, _score: f64| match sum {
            Value::Number(sum) => Ok(Value::Number(sum + price_of(document))),
            _ => Err("the sum is a number".to_string()),
        }),
        initial_value: Arc::new(|| Value::Number(0.0)),
    }
}

async fn check_searches(node: &ClusterNode, documents: &[ShopDocument]) {
    let mut in_id_order: Vec<String> = documents.iter().map(|doc| doc.id.clone()).collect();
    in_id_order.sort();
    let mut ranked = Vec::new();
    let mut cursor = None;
    for _ in 0..PAGE_BUDGET {
        let page = node
            .query(
                INDEX,
                &QueryParams {
                    search_after: cursor.clone(),
                    ..dfs_grinder_query(PAGE_SIZE)
                },
            )
            .await
            .expect("the router ranks a page across every partition");
        assert_eq!(page.count, DOCUMENT_TOTAL as u64);
        assert!(page.count_exact);
        assert_eq!(page.coverage.queried_partitions, PARTITIONS as usize);
        ranked.extend(hit_ids(&page));
        cursor = page.cursor;
        if ranked.len() >= DOCUMENT_TOTAL || cursor.is_none() {
            break;
        }
    }
    assert_eq!(ranked, in_id_order);

    let pinned = node
        .query(
            INDEX,
            &QueryParams {
                pinned: Some(vec![Pin {
                    doc_id: "item-5".to_string(),
                    position: 0,
                }]),
                ..dfs_grinder_query(3)
            },
        )
        .await
        .expect("the router places a pin");
    assert_eq!(hit_ids(&pinned), ["item-5", "item-0", "item-1"]);

    let mut by_trailing_number: Vec<&ShopDocument> = documents.iter().collect();
    by_trailing_number.sort_by(|left, right| right.price.total_cmp(&left.price));
    let reranked = node
        .query(
            INDEX,
            &QueryParams {
                rerank: Some(RerankConfig {
                    adapter: TRAILING_NUMBER_RERANKER.to_string(),
                    fields: vec!["title".to_string()],
                    query: None,
                    window: None,
                }),
                ..dfs_grinder_query(3)
            },
        )
        .await
        .expect("the router reranks the best hits of every partition");
    assert_eq!(
        hit_ids(&reranked),
        by_trailing_number[..3]
            .iter()
            .map(|document| document.id.clone())
            .collect::<Vec<_>>()
    );
    assert_eq!(reranked.count, DOCUMENT_TOTAL as u64);
    for (hit, expected) in reranked.hits.iter().zip(&by_trailing_number) {
        assert_eq!(
            hit.document.get("title"),
            Some(&Value::from(expected.title.as_str()))
        );
    }

    let mut kitchen: Vec<&ShopDocument> = documents
        .iter()
        .filter(|document| document.category == "kitchen")
        .collect();
    kitchen.sort_by(|left, right| right.price.total_cmp(&left.price));
    let kitchen_ids: Vec<String> = kitchen.iter().map(|doc| doc.id.clone()).collect();
    let sorted = QueryParams {
        sort: Some(vec![SortField {
            field: "price".to_string(),
            direction: SortDirection::Desc,
            mode: None,
        }]),
        offset: Some(1),
        document: Some(DocumentProjection::Fields {
            include: Some(vec!["title".to_string()]),
            exclude: None,
            vectors: None,
        }),
        ..QueryParams {
            limit: Some(3),
            ..grinder_query(Some(kitchen_filter()))
        }
    };
    let first = node
        .query(INDEX, &sorted)
        .await
        .expect("the router merges sorted pages");
    assert_eq!(hit_ids(&first), kitchen_ids[1..4]);
    for hit in &first.hits {
        assert_eq!(hit.score, None);
        let title = documents
            .iter()
            .find(|document| document.id == hit.id)
            .map(|document| Value::from(document.title.as_str()));
        assert_eq!(hit.document.get("title"), title.as_ref());
        assert_eq!(hit.document.len(), 1);
    }
    let next = node
        .query(
            INDEX,
            &QueryParams {
                search_after: first.cursor.clone(),
                offset: None,
                ..sorted
            },
        )
        .await
        .expect("the router continues a sorted search from its cursor");
    assert_eq!(hit_ids(&next), kitchen_ids[4..7]);

    let faceted = node
        .query(
            INDEX,
            &QueryParams {
                facets: Some(vec![("category".to_string(), FacetSpec::default())]),
                ..dfs_grinder_query(1)
            },
        )
        .await
        .expect("the router merges the facet counts");
    let facets = faceted.facets.expect("the search counts the categories");
    let counted = &facets[0].1;
    let workshop = (DOCUMENT_TOTAL - kitchen.len()) as u64;
    assert_eq!(
        counted.values,
        [
            ("workshop".to_string(), workshop),
            ("kitchen".to_string(), kitchen.len() as u64)
        ]
    );
    assert_eq!(counted.error_bound, 0);

    let grouped = node
        .query(
            INDEX,
            &QueryParams {
                group: Some(GroupConfig {
                    fields: vec!["category".to_string()],
                    max_per_group: Some(2),
                    limit: None,
                    reduce: Some(price_sum()),
                }),
                ..dfs_grinder_query(DOCUMENT_TOTAL)
            },
        )
        .await
        .expect("the router merges the groups of every node");
    let groups = grouped.groups.expect("the search groups the hits");
    let by_id = |category: &str| -> Vec<String> {
        let mut ids: Vec<String> = documents
            .iter()
            .filter(|document| document.category == category)
            .map(|document| document.id.clone())
            .collect();
        ids.sort();
        ids.truncate(2);
        ids
    };
    let summed = |category: &str| -> f64 {
        documents
            .iter()
            .filter(|document| document.category == category)
            .map(|document| document.price)
            .sum()
    };
    let shape: Vec<GroupShape> = groups
        .iter()
        .map(|group| {
            let ids = group.hits.iter().map(|hit| hit.id.clone()).collect();
            (group.values.clone(), ids, group.reduced.clone())
        })
        .collect();
    assert_eq!(
        shape,
        [
            (
                vec![("category".to_string(), Some(Value::from("kitchen")))],
                by_id("kitchen"),
                Some(Value::Number(summed("kitchen")))
            ),
            (
                vec![("category".to_string(), Some(Value::from("workshop")))],
                by_id("workshop"),
                Some(Value::Number(summed("workshop")))
            ),
        ]
    );
}

fn listed_ids(result: &narsil::ListResult) -> Vec<String> {
    result
        .documents
        .iter()
        .map(|listed| listed.id.clone())
        .collect()
}

async fn active_primaries(coordinator: &EtcdCoordinator) -> Option<BTreeMap<u32, String>> {
    let table = coordinator
        .allocation(INDEX)
        .await
        .expect("etcd answers for the table")?;
    if table.assignments.len() != PARTITIONS as usize {
        return None;
    }
    let mut primaries = BTreeMap::new();
    for (partition_id, assignment) in &table.assignments {
        if assignment.get("state").and_then(Value::as_str) != Some("ACTIVE") {
            return None;
        }
        let primary = assignment.get("primary").and_then(Value::as_str)?;
        primaries.insert(*partition_id as u32, primary.to_string());
    }
    HOLDER_IDS
        .iter()
        .chain([&ROUTER_ID])
        .all(|holder| primaries.values().any(|primary| primary == holder))
        .then_some(primaries)
}

async fn settled_primaries(coordinator: &EtcdCoordinator) -> BTreeMap<u32, String> {
    eventually(
        "every partition is ACTIVE and each data node leads one",
        || async { active_primaries(coordinator).await.is_some() },
    )
    .await;
    active_primaries(coordinator)
        .await
        .expect("every partition is settled")
}

fn without_id(document: &Map) -> Map {
    let mut stored = document.clone();
    stored.remove("id");
    stored
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rust_coordinator_reads_every_partition_from_typescript_data_nodes_and_its_own_copies() {
    let Some(endpoint) = etcd_endpoint() else {
        return;
    };
    let key_prefix = unique_key_prefix();
    let ttl = EtcdCoordinatorConfig::default().node_heartbeat_ttl_seconds;
    let coordinator = coordinator_at(endpoint.clone(), key_prefix.clone(), ttl).await;
    let controller_scratch = Scratch::new();
    let controller = start_controller(&coordinator, &controller_scratch).await;
    let mut first_holder =
        TypescriptNode::start(&endpoint, &key_prefix, HOLDER_IDS[0], "data").await;
    let second_holder = TypescriptNode::start(&endpoint, &key_prefix, HOLDER_IDS[1], "data").await;
    let router_scratch = Scratch::new();
    let router = DataNode::start_configured(
        &coordinator,
        ROUTER_ID,
        router_scratch.path(),
        &["coordinator", "data"],
        with_trailing_number_reranker,
    )
    .await;

    let schema = Value::Object(fields([
        ("title", Value::from("string")),
        ("price", Value::from("number")),
        ("category", Value::from("enum")),
    ]));
    first_holder
        .create_index_with_schema(INDEX, u64::from(PARTITIONS), 0, schema.clone(), Map::new())
        .await;
    let primaries = settled_primaries(&coordinator).await;
    let documents = shop_documents();
    let written = first_holder
        .call(
            "insertBatch",
            fields([
                ("indexName", Value::from(INDEX)),
                (
                    "documents",
                    Value::Array(documents.iter().map(written_form).collect()),
                ),
            ]),
        )
        .await
        .value();
    let Value::Object(outcome) = written else {
        panic!("the TypeScript node reports the batch outcome");
    };
    assert_eq!(outcome.get("failed"), Some(&Value::Array(Vec::new())));
    let oracle: BTreeMap<String, Map> = documents
        .iter()
        .map(|document| (document.id.clone(), stored_form(document)))
        .collect();

    let node = &router.node;
    for document in &documents {
        let read = node
            .get(INDEX, &document.id)
            .await
            .expect("the router reads the document from its holder")
            .expect("the cluster holds the document");
        assert_eq!(without_id(&read), oracle[&document.id], "{}", document.id);
        assert!(
            node.has(INDEX, &document.id)
                .await
                .expect("the router checks the document")
        );
    }
    assert_eq!(
        node.get(INDEX, "item-missing")
            .await
            .expect("the router reads"),
        None
    );
    assert!(
        !node
            .has(INDEX, "item-missing")
            .await
            .expect("the router checks")
    );
    let wanted: Vec<String> = ["item-1", "item-2", "item-missing"]
        .into_iter()
        .map(str::to_string)
        .collect();
    let many = node
        .get_multiple(INDEX, &wanted)
        .await
        .expect("the router reads many documents");
    assert_eq!(
        many.keys().cloned().collect::<Vec<_>>(),
        ["item-1", "item-2"]
    );

    assert_eq!(
        node.count_documents(INDEX)
            .await
            .expect("the router counts"),
        DOCUMENT_TOTAL as u64
    );
    let stats = node
        .get_stats(INDEX)
        .await
        .expect("the router reads the stats");
    assert_eq!(stats.document_count, DOCUMENT_TOTAL as u64);
    assert_eq!(stats.partition_count, PARTITIONS as usize);
    assert_eq!(stats.language, "english");
    assert_eq!(stats.schema, schema);
    assert!(stats.estimated_memory_bytes > 0);
    let partitions = node
        .get_partition_stats(INDEX)
        .await
        .expect("the router reads the partition stats");
    assert_eq!(
        partitions
            .iter()
            .map(|entry| entry.partition_id)
            .collect::<Vec<_>>(),
        (0..PARTITIONS).collect::<Vec<_>>()
    );
    assert_eq!(
        partitions
            .iter()
            .map(|entry| entry.document_count)
            .sum::<u64>(),
        DOCUMENT_TOTAL as u64
    );

    let suggested = node
        .suggest(
            INDEX,
            &SuggestParams {
                prefix: "grind".to_string(),
                limit: None,
            },
        )
        .await
        .expect("the router merges the completions");
    let grinder = suggested
        .terms
        .iter()
        .find(|entry| entry.term.starts_with("grind"))
        .expect("the completions hold the grinder");
    assert_eq!(grinder.document_frequency, DOCUMENT_TOTAL as u64);

    let mut collected = Vec::new();
    let mut cursor = None;
    for _ in 0..PAGE_BUDGET {
        let page = node
            .list_documents(
                INDEX,
                &ListParams {
                    cursor: cursor.clone(),
                    limit: Some(PAGE_SIZE),
                    ..ListParams::default()
                },
            )
            .await
            .expect("the router lists a page");
        assert_eq!(page.total, DOCUMENT_TOTAL as u64);
        collected.extend(listed_ids(&page));
        cursor = page.cursor;
        if cursor.is_none() {
            break;
        }
    }
    let mut in_id_order: Vec<String> = oracle.keys().cloned().collect();
    in_id_order.sort();
    assert_eq!(collected, in_id_order);

    let whole = node
        .list_documents(
            INDEX,
            &ListParams {
                limit: Some(MAX_PAGE_SIZE),
                ..ListParams::default()
            },
        )
        .await
        .expect("the router lists the largest page");
    assert_eq!(whole.documents.len(), DOCUMENT_TOTAL);
    assert_eq!(whole.cursor, None);
    assert_eq!(whole.total, DOCUMENT_TOTAL as u64);

    let mut kitchen: Vec<&ShopDocument> = documents
        .iter()
        .filter(|document| document.category == "kitchen")
        .collect();
    kitchen.sort_by(|left, right| right.price.total_cmp(&left.price));
    let filtered = node
        .list_documents_sorted(
            INDEX,
            &ListParams {
                limit: Some(DOCUMENT_TOTAL),
                filters: Some(kitchen_filter()),
                document: Some(DocumentProjection::Fields {
                    include: Some(vec!["title".to_string()]),
                    exclude: None,
                    vectors: None,
                }),
                ..ListParams::default()
            },
            &[SortField {
                field: "price".to_string(),
                direction: SortDirection::Desc,
                mode: None,
            }],
        )
        .await
        .expect("the router lists with a filter, a sort, and a projection");
    assert_eq!(filtered.total, kitchen.len() as u64);
    assert_eq!(
        listed_ids(&filtered),
        kitchen
            .iter()
            .map(|document| document.id.clone())
            .collect::<Vec<_>>()
    );
    for listed in &filtered.documents {
        assert_eq!(
            listed.document.keys().cloned().collect::<Vec<_>>(),
            ["title"]
        );
    }

    let preflight = node
        .preflight(INDEX, &grinder_query(Some(kitchen_filter())))
        .await
        .expect("the router counts the matches of a query");
    assert_eq!(preflight.count, kitchen.len() as u64);
    assert!(preflight.count_exact);
    check_searches(node, &documents).await;

    let mut sorted = Vec::new();
    let mut cursor = None;
    let ascending = [SortField {
        field: "price".to_string(),
        direction: SortDirection::Asc,
        mode: None,
    }];
    for _ in 0..PAGE_BUDGET {
        let page = node
            .list_documents_sorted(
                INDEX,
                &ListParams {
                    cursor: cursor.clone(),
                    limit: Some(SORTED_PAGE_SIZE),
                    ..ListParams::default()
                },
                &ascending,
            )
            .await
            .expect("the router continues the sorted listing");
        sorted.extend(listed_ids(&page));
        cursor = page.cursor;
        if cursor.is_none() {
            break;
        }
    }
    let mut by_price: Vec<&ShopDocument> = documents.iter().collect();
    by_price.sort_by(|left, right| left.price.total_cmp(&right.price));
    assert_eq!(
        sorted,
        by_price
            .iter()
            .map(|document| document.id.clone())
            .collect::<Vec<_>>()
    );

    let listed = node
        .list_indexes()
        .await
        .expect("the router lists the indexes");
    let shop = listed
        .iter()
        .find(|index| index.name == INDEX)
        .expect("the listing holds the index");
    assert_eq!(shop.document_count, DOCUMENT_TOTAL as u64);
    assert_eq!(shop.partition_count, PARTITIONS as usize);

    let stranded = documents
        .iter()
        .find(|document| primaries[&fnv1a_partition(&document.id, PARTITIONS)] == HOLDER_IDS[1])
        .expect("the second holder serves a partition of some document");
    second_holder.kill().await;
    let refusals = [
        node.count_documents(INDEX).await.err(),
        node.get_stats(INDEX).await.err(),
        node.list_documents(
            INDEX,
            &ListParams {
                limit: Some(PAGE_SIZE),
                ..ListParams::default()
            },
        )
        .await
        .err(),
        node.suggest(
            INDEX,
            &SuggestParams {
                prefix: "grind".to_string(),
                limit: None,
            },
        )
        .await
        .err(),
        node.get(INDEX, &stranded.id).await.err(),
        node.preflight(INDEX, &grinder_query(None)).await.err(),
    ];
    for refusal in refusals {
        let refusal = refusal.expect("a read that reaches the stopped holder fails");
        assert_eq!(refusal.code(), codes::QUERY_NO_ACTIVE_REPLICA, "{refusal}");
    }
    let partial = node
        .query(INDEX, &dfs_grinder_query(DOCUMENT_TOTAL))
        .await
        .expect("a search answers from the partitions that remain");
    assert!(partial.coverage.failed_partitions + partial.coverage.timed_out_partitions > 0);
    assert!(!partial.count_exact);
    for hit in &partial.hits {
        let partition = fnv1a_partition(&hit.id, PARTITIONS);
        assert_ne!(primaries[&partition], HOLDER_IDS[1], "{}", hit.id);
    }

    router.stop().await;
    first_holder.shutdown().await;
    controller.stop().await;
    coordinator.shutdown().await;
}
