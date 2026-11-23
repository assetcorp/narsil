use std::collections::BTreeMap;

use narsil::{
    DocumentProjection, ListParams, Map, QueryParams, SortDirection, SortField, SuggestParams,
    Value,
};
use narsil_cluster::coordinator::etcd::{EtcdCoordinator, EtcdCoordinatorConfig};
use narsil_cluster::error::codes;

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
        .all(|holder| primaries.values().any(|primary| primary == holder))
        .then_some(primaries)
}

async fn settled_primaries(coordinator: &EtcdCoordinator) -> BTreeMap<u32, String> {
    eventually(
        "every partition is ACTIVE and each holder leads one",
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
async fn a_rust_coordinator_reads_every_partition_from_typescript_data_nodes() {
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
    let router = DataNode::start_with_roles(
        &coordinator,
        ROUTER_ID,
        router_scratch.path(),
        &["coordinator"],
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

    router.stop().await;
    first_holder.shutdown().await;
    controller.stop().await;
    coordinator.shutdown().await;
}
