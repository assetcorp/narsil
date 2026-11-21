use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use narsil::{Map, Value};
use narsil_cluster::SPEC_VERSION;
use narsil_cluster::coordinator::etcd::{EtcdCoordinator, EtcdCoordinatorConfig, WatchHandle};
use narsil_cluster::coordinator::{NodeCapacity, NodeEvent, NodeRegistration, SchemaEvent};
use narsil_cluster::node::next_started_at;

const EVENT_WAIT: Duration = Duration::from_secs(10);
const EVENT_POLL: Duration = Duration::from_millis(100);
const HEARTBEAT_TTL_SECONDS: u64 = 5;

type Events = Arc<Mutex<Vec<String>>>;

struct Tenant {
    name: &'static str,
    coordinator: EtcdCoordinator,
    node_events: Events,
    schema_events: Events,
    watches: Vec<WatchHandle>,
}

fn recorded(events: &Events) -> Vec<String> {
    events
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

fn record(events: &Events, event: String) {
    events
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .push(event);
}

fn registration(node_id: String) -> NodeRegistration {
    NodeRegistration {
        node_id,
        address: "127.0.0.1:9200".to_string(),
        roles: vec!["coordinator".to_string()],
        capacity: NodeCapacity::default(),
        started_at: next_started_at(),
        version: SPEC_VERSION.to_string(),
        extra: Map::new(),
    }
}

fn schema() -> Value {
    let mut fields = Map::new();
    fields.insert("title".to_string(), Value::String("string".to_string()));
    Value::Object(fields)
}

async fn tenant(endpoint: &str, name: &'static str, key_prefix: String) -> Tenant {
    let coordinator = EtcdCoordinator::connect(EtcdCoordinatorConfig {
        endpoints: vec![endpoint.to_string()],
        key_prefix,
        node_heartbeat_ttl_seconds: HEARTBEAT_TTL_SECONDS,
        ..EtcdCoordinatorConfig::default()
    })
    .await
    .expect("the coordinator connects");
    let node_events: Events = Arc::default();
    let schema_events: Events = Arc::default();
    let nodes_seen = Arc::clone(&node_events);
    let schemas_seen = Arc::clone(&schema_events);
    let watches = vec![
        coordinator
            .watch_nodes(move |event| {
                let text = match event {
                    NodeEvent::Joined(joined) => format!("node_joined {}", joined.node_id),
                    NodeEvent::Left(node_id) => format!("node_left {node_id}"),
                };
                record(&nodes_seen, text);
            })
            .await
            .expect("the node watch starts"),
        coordinator
            .watch_schemas(move |event| {
                let text = match event {
                    SchemaEvent::Created { index_name, .. } => {
                        format!("schema_created {index_name}")
                    }
                    SchemaEvent::Dropped { index_name } => format!("schema_dropped {index_name}"),
                };
                record(&schemas_seen, text);
            })
            .await
            .expect("the schema watch starts"),
    ];
    Tenant {
        name,
        coordinator,
        node_events,
        schema_events,
        watches,
    }
}

async fn wait_for(events: &Events, last: &str) {
    let deadline = Instant::now() + EVENT_WAIT;
    while !recorded(events).iter().any(|event| event == last) {
        assert!(Instant::now() < deadline, "{last} never arrived");
        tokio::time::sleep(EVENT_POLL).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn clusters_whose_key_prefixes_nest_list_and_watch_only_their_own_records() {
    let Some(endpoint) = std::env::var("NARSIL_ETCD_ENDPOINT")
        .ok()
        .filter(|endpoint| !endpoint.is_empty())
    else {
        return;
    };
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    let outer = format!("_narsil_rust_nested_{nanos}");
    let tenants = vec![
        tenant(&endpoint, "outer", outer.clone()).await,
        tenant(&endpoint, "nodes-eu", format!("{outer}/nodes-eu")).await,
        tenant(&endpoint, "schema-eu", format!("{outer}/schema-eu")).await,
        tenant(&endpoint, "nodes", format!("{outer}/nodes")).await,
        tenant(&endpoint, "schema", format!("{outer}/schema")).await,
    ];

    for tenant in tenants.iter().rev() {
        tenant
            .coordinator
            .register_node(&registration(format!("{}-node", tenant.name)))
            .await
            .expect("the node registers");
        tenant
            .coordinator
            .put_schema(&format!("{}-catalogue", tenant.name), &schema())
            .await
            .expect("the schema is stored");
    }

    for tenant in &tenants {
        let node_ids: Vec<String> = tenant
            .coordinator
            .list_nodes()
            .await
            .expect("the nodes are listed")
            .into_iter()
            .map(|node| node.node_id)
            .collect();
        assert_eq!(node_ids, [format!("{}-node", tenant.name)]);
        assert_eq!(
            tenant
                .coordinator
                .list_schemas()
                .await
                .expect("the schemas are listed"),
            [format!("{}-catalogue", tenant.name)]
        );
    }

    for tenant in tenants.iter().rev() {
        tenant
            .coordinator
            .deregister_node(&format!("{}-node", tenant.name))
            .await
            .expect("the node deregisters");
        tenant
            .coordinator
            .drop_schema(&format!("{}-catalogue", tenant.name))
            .await
            .expect("the schema is dropped");
    }

    for tenant in tenants {
        let node = format!("{}-node", tenant.name);
        let catalogue = format!("{}-catalogue", tenant.name);
        wait_for(&tenant.node_events, &format!("node_left {node}")).await;
        wait_for(
            &tenant.schema_events,
            &format!("schema_dropped {catalogue}"),
        )
        .await;
        assert_eq!(
            recorded(&tenant.node_events),
            [format!("node_joined {node}"), format!("node_left {node}")]
        );
        assert_eq!(
            recorded(&tenant.schema_events),
            [
                format!("schema_created {catalogue}"),
                format!("schema_dropped {catalogue}")
            ]
        );
        for watch in tenant.watches {
            watch.stop();
        }
        tenant.coordinator.shutdown().await;
    }
}
