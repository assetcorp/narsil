use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use jiff::tz::TimeZone;
use jiff::{Span, Timestamp};
use narsil::{
    FilesystemPersistence, IndexConfig, Map, QuerySuggestionsConfig, QuerySuggestionsSetting,
    RecordedQuery, Value, decode_msgpack, encode_msgpack,
};
use narsil_cluster::coordinator::etcd::EtcdCoordinatorConfig;
use narsil_cluster::coordinator::{NodeCapacity, NodeRegistration};
use narsil_cluster::message::TransportMessage;
use narsil_cluster::node::{
    ClusterBackupConfig, CreateBackupOptions, CreateIndexOptions, RestoreBackupOptions,
    next_started_at,
};
use narsil_cluster::transport::tcp::{TcpTransport, TcpTransportConfig};
use narsil_cluster::transport::{Listening, NodeTransport, Respond, listen_handler};

use crate::data_node::{
    DataNode, Scratch, coordinator_at, etcd_endpoint, eventually, title_schema, unique_key_prefix,
};
use crate::typescript_node::{TypescriptNode, fields};

const SOURCE: &str = "catalogue";
const PHRASE: &str = "trail shoes";
const KEY: [u8; 32] = [11; 32];
const RUST_CONTROLLER: &str = "suggest-a";
const TYPESCRIPT_COUNTER: &str = "suggest-b";
const HOSTILE_PEER: &str = "suggest-0";
const BACKUP: &str = "catalogue-history";
const BACKUP_KEY_PREFIX: &str = "clusters/catalogue";
const BUILD_RECORD_KEY: &str = "_narsil/query-suggestions/catalogue/build";
const SUGGESTIONS_PREFIX: &str = "catalogue.suggestions.";
const COUNTS_MESSAGE: &str = "suggestions.counts";
const HISTORY_FOLDER: &str = "_query-counts";
const STALE_INDEX_UUID: &str = "0190a000-0000-7000-8000-000000000000";
const HEADER_BYTES: usize = 32;
const LEADING_HEADER_BYTES: usize = 8;
const CHECKSUM_FLAG: u16 = 0x0008;
const SCRAMBLED_ID_BYTES: usize = 16;
const DAY_MS: f64 = 86_400_000.0;
const CUT_OFF_FRAME_DECLARED_BYTES: u32 = 100;
const CUT_OFF_FRAME_SENT_BYTES: usize = 10;
const BUILD_MAX_GROUPS: u32 = 3;
const PREVIEW_MAX_GROUPS: u32 = 10;

fn day(days_ago: i64) -> String {
    let today = Timestamp::now().to_zoned(TimeZone::UTC).date();
    today
        .checked_sub(Span::new().days(days_ago))
        .expect("the date is in range")
        .to_string()
}

fn setting(max_groups: u32) -> QuerySuggestionsSetting {
    QuerySuggestionsSetting {
        enabled: true,
        fields: vec!["title".to_string()],
        min_people: Some(2),
        min_results: Some(1),
        schedule: Some("off".to_string()),
        max_groups: Some(max_groups),
        ..QuerySuggestionsSetting::default()
    }
}

fn history_file(directory: &Path, day: &str) -> PathBuf {
    directory
        .join(HISTORY_FOLDER)
        .join(SOURCE)
        .join(format!("{day}.nrsl"))
}

fn scrambled_person() -> Value {
    let mut bytes = vec![0; SCRAMBLED_ID_BYTES];
    getrandom::fill(&mut bytes).expect("the system gives random bytes");
    Value::Bytes(bytes)
}

fn searched_by_two(groups: &[&str]) -> Value {
    let mut by_group = Map::new();
    for group in groups {
        let phrase = fields([
            ("phrase", Value::from(PHRASE)),
            ("count", Value::from(2u32)),
            (
                "people",
                Value::Array(vec![scrambled_person(), scrambled_person()]),
            ),
        ]);
        by_group.insert(*group, Value::Array(vec![Value::Object(phrase)]));
    }
    Value::Object(by_group)
}

struct DayFile<'a> {
    day: String,
    days_ago: f64,
    index_uuid: &'a str,
    groups: &'a [&'a str],
}

fn forged_day(template_file: &[u8], file: &DayFile<'_>) -> Vec<u8> {
    let length = u32::from_be_bytes(template_file[8..12].try_into().expect("four bytes")) as usize;
    let Ok(Value::Object(mut payload)) =
        decode_msgpack(&template_file[HEADER_BYTES..HEADER_BYTES + length])
    else {
        panic!("the TypeScript node writes a MessagePack map into its counts file");
    };
    let saved_at = payload
        .get("savedAt")
        .and_then(Value::as_f64)
        .expect("the counts file records when it was saved");
    payload.insert("day", Value::from(file.day.as_str()));
    payload.insert("savedAt", Value::Number(saved_at - file.days_ago * DAY_MS));
    payload.insert("indexUuid", Value::from(file.index_uuid));
    payload.insert("groups", searched_by_two(file.groups));
    let body = encode_msgpack(&Value::Object(payload)).expect("the payload encodes");
    let mut forged = vec![0; HEADER_BYTES];
    forged[..LEADING_HEADER_BYTES].copy_from_slice(&template_file[..LEADING_HEADER_BYTES]);
    forged[8..12].copy_from_slice(&(body.len() as u32).to_be_bytes());
    forged[12..14].copy_from_slice(&CHECKSUM_FLAG.to_be_bytes());
    forged[14..18].copy_from_slice(&crc32fast::hash(&body).to_be_bytes());
    forged.extend_from_slice(&body);
    forged
}

fn frame(key: &str, declared_bytes: u32, body: &[u8]) -> Vec<u8> {
    let mut framed = Vec::with_capacity(6 + key.len() + body.len());
    framed.extend_from_slice(&(key.len() as u16).to_be_bytes());
    framed.extend_from_slice(key.as_bytes());
    framed.extend_from_slice(&declared_bytes.to_be_bytes());
    framed.extend_from_slice(body);
    framed
}

fn template_index_uuid(template_file: &[u8]) -> String {
    let length = u32::from_be_bytes(template_file[8..12].try_into().expect("four bytes")) as usize;
    let Ok(Value::Object(payload)) =
        decode_msgpack(&template_file[HEADER_BYTES..HEADER_BYTES + length])
    else {
        panic!("the TypeScript node writes a MessagePack map into its counts file");
    };
    payload
        .get("indexUuid")
        .and_then(Value::as_str)
        .expect("a cluster node writes the index UUID into each counts file")
        .to_string()
}

struct HostilePeer {
    transport: Arc<TcpTransport>,
    listening: Listening,
    asked: Arc<AtomicUsize>,
}

async fn hostile_peer(stream: Vec<u8>) -> HostilePeer {
    let transport = Arc::new(
        TcpTransport::new(
            HOSTILE_PEER,
            TcpTransportConfig {
                host: "127.0.0.1".to_string(),
                port: 0,
                ..TcpTransportConfig::default()
            },
        )
        .expect("the transport settings are valid"),
    );
    let asked = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&asked);
    let listening = transport
        .listen(listen_handler(
            move |message: TransportMessage, respond: Respond| {
                let (stream, counted) = (stream.clone(), Arc::clone(&counted));
                async move {
                    if message.message_type == COUNTS_MESSAGE {
                        counted.fetch_add(1, Ordering::SeqCst);
                        let reply = TransportMessage::new(
                            COUNTS_MESSAGE,
                            HOSTILE_PEER,
                            message.request_id.as_str(),
                            stream,
                        );
                        respond.send(reply).await;
                    }
                    Ok(())
                }
            },
        ))
        .await
        .expect("the hostile peer listens");
    HostilePeer {
        transport,
        listening,
        asked,
    }
}

fn preview_groups(entries: &[narsil::QuerySuggestionPreviewEntry]) -> Vec<(String, String, u64)> {
    let mut groups: Vec<(String, String, u64)> = entries
        .iter()
        .map(|entry| (entry.group.clone(), entry.query.clone(), entry.count))
        .collect();
    groups.sort();
    groups
}

#[tokio::test(flavor = "multi_thread")]
async fn query_history_from_another_index_or_a_broken_stream_reaches_no_build_and_no_backup() {
    let Some(endpoint) = etcd_endpoint() else {
        return;
    };
    let key_prefix = unique_key_prefix();
    let ttl = EtcdCoordinatorConfig::default().node_heartbeat_ttl_seconds;
    let coordinator = coordinator_at(endpoint.clone(), key_prefix.clone(), ttl).await;
    let (store, rust_scratch, typescript_scratch) =
        (Scratch::new(), Scratch::new(), Scratch::new());
    let store_directory = store.path().to_path_buf();
    let controller = DataNode::start_configured(
        &coordinator,
        RUST_CONTROLLER,
        rust_scratch.path(),
        &["data", "coordinator", "controller"],
        |config| {
            config.backups = Some(ClusterBackupConfig {
                store: Arc::new(
                    FilesystemPersistence::new(&store_directory).expect("the store is a directory"),
                ),
                key_prefix: BACKUP_KEY_PREFIX.to_string(),
            });
            config.query_suggestions = Some(QuerySuggestionsConfig { key: KEY.to_vec() });
        },
    )
    .await;
    eventually("the Rust node holds the controller lease", || async {
        controller.node.is_controller()
    })
    .await;
    let options = CreateIndexOptions {
        partition_count: Some(1),
        replication_factor: Some(0),
        wait_for_serving_ms: None,
    };
    controller
        .node
        .create_index(SOURCE, IndexConfig::new(title_schema()), options)
        .await
        .expect("the Rust controller creates the source index");
    let shoe = fields([("title", Value::from(format!("{PHRASE} for wet ground")))]);
    controller
        .node
        .insert(SOURCE, shoe, Some("shoe-1"))
        .await
        .expect("the source index takes a document");
    let suggestions = controller.node.query_suggestions();
    suggestions
        .update_setting(SOURCE, &setting(BUILD_MAX_GROUPS))
        .await
        .expect("the Rust node turns query suggestions on");
    for person in ["person-1", "person-2"] {
        let query = RecordedQuery {
            query: PHRASE.to_string(),
            person: person.to_string(),
            group: "alpha".to_string(),
        };
        let counted = suggestions.record_query(SOURCE, &query).await;
        assert!(counted.expect("the Rust node counts the search").recorded);
    }

    let mut counter = TypescriptNode::start_durable(
        &endpoint,
        &key_prefix,
        TYPESCRIPT_COUNTER,
        "coordinator",
        typescript_scratch.path(),
    )
    .await;
    for person in ["person-1", "person-2"] {
        let query = fields([
            ("query", Value::from(PHRASE)),
            ("person", Value::from(person)),
            ("group", Value::from("beta")),
        ]);
        let recorded = counter
            .call(
                "recordQuery",
                fields([
                    ("indexName", Value::from(SOURCE)),
                    ("query", Value::Object(query)),
                ]),
            )
            .await
            .value();
        assert_eq!(
            recorded
                .as_object()
                .and_then(|answer| answer.get("recorded")),
            Some(&Value::Bool(true))
        );
    }
    counter
        .call(
            "previewSuggestions",
            fields([("indexName", Value::from(SOURCE))]),
        )
        .await
        .value();
    let today_path = history_file(typescript_scratch.path(), &day(0));
    let template = std::fs::read(&today_path).expect("the TypeScript node saved its counts");
    let index_uuid = template_index_uuid(&template);
    let yesterday_path = history_file(typescript_scratch.path(), &day(1));
    let yesterday = DayFile {
        day: day(1),
        days_ago: 1.0,
        index_uuid: &index_uuid,
        groups: &["yankee", "zulu"],
    };
    std::fs::write(&yesterday_path, forged_day(&template, &yesterday))
        .expect("the counter's history folder takes a file");
    let stale_path = history_file(typescript_scratch.path(), &day(2));
    let stale = DayFile {
        day: day(2),
        days_ago: 2.0,
        index_uuid: STALE_INDEX_UUID,
        groups: &["mallory"],
    };
    std::fs::write(&stale_path, forged_day(&template, &stale))
        .expect("the counter's history folder takes a file");

    let hostile_day = DayFile {
        day: day(0),
        days_ago: 0.0,
        index_uuid: &index_uuid,
        groups: &["oscar"],
    };
    let honest_file = forged_day(&template, &hostile_day);
    let day_key = format!("{}.nrsl", day(0));
    let mut broken_stream = frame(&day_key, honest_file.len() as u32, &honest_file);
    broken_stream.extend(frame(
        &day_key,
        CUT_OFF_FRAME_DECLARED_BYTES,
        &[0; CUT_OFF_FRAME_SENT_BYTES],
    ));
    let hostile = hostile_peer(broken_stream).await;
    coordinator
        .register_node(&NodeRegistration {
            node_id: HOSTILE_PEER.to_string(),
            address: format!("127.0.0.1:{}", hostile.transport.port()),
            roles: vec!["coordinator".to_string()],
            capacity: NodeCapacity::default(),
            started_at: next_started_at(),
            version: "1.4".to_string(),
            extra: Map::new(),
        })
        .await
        .expect("etcd takes the hostile peer's registration");

    let build = counter
        .call(
            "buildSuggestions",
            fields([("indexName", Value::from(SOURCE))]),
        )
        .await
        .value();
    assert_eq!(
        build.as_object().and_then(|answer| answer.get("status")),
        Some(&Value::from("completed"))
    );
    assert!(hostile.asked.load(Ordering::SeqCst) > 0);
    let mut built: Vec<String> = controller
        .node
        .list_indexes()
        .await
        .expect("the controller lists the indexes")
        .into_iter()
        .filter_map(|index| {
            index
                .name
                .strip_prefix(SUGGESTIONS_PREFIX)
                .map(str::to_string)
        })
        .collect();
    built.sort();
    assert_eq!(built, ["alpha", "yankee", "zulu"]);

    let backup_options = CreateBackupOptions {
        query_history: true,
        on_progress: None,
    };
    controller
        .node
        .create_backup(SOURCE, BACKUP, &backup_options)
        .await
        .expect("the Rust controller backs the index up with its query history");

    counter
        .call("dropIndex", fields([("indexName", Value::from(SOURCE))]))
        .await
        .value();
    let remaining = controller
        .node
        .list_indexes()
        .await
        .expect("the controller lists the indexes");
    assert!(remaining.is_empty(), "{remaining:?}");
    assert_eq!(
        coordinator
            .get(BUILD_RECORD_KEY)
            .await
            .expect("etcd answers"),
        None
    );
    for path in [&today_path, &yesterday_path, &stale_path] {
        assert!(!path.exists(), "{path:?} outlived the drop");
    }
    let rust_history = rust_scratch.path().join(HISTORY_FOLDER).join(SOURCE);
    eventually(
        "the Rust node forgets the history of the dropped index",
        || {
            let rust_history = rust_history.clone();
            async move {
                std::fs::read_dir(&rust_history)
                    .map_or(true, |mut entries| entries.next().is_none())
            }
        },
    )
    .await;

    let restore_options = RestoreBackupOptions {
        index_name: SOURCE.to_string(),
        replication_factor: Some(0),
        ..RestoreBackupOptions::default()
    };
    controller
        .node
        .restore_backup(BACKUP, &restore_options)
        .await
        .expect("the Rust controller restores the backup");
    suggestions
        .update_setting(SOURCE, &setting(PREVIEW_MAX_GROUPS))
        .await
        .expect("the restored index takes a wider setting");
    let preview = suggestions
        .preview(SOURCE, None)
        .await
        .expect("the Rust controller previews the restored history");
    let expected: Vec<(String, String, u64)> = ["alpha", "beta", "yankee", "zulu"]
        .into_iter()
        .map(|group| (group.to_string(), PHRASE.to_string(), 2))
        .collect();
    assert_eq!(preview_groups(&preview.entries), expected);

    counter.shutdown().await;
    let _ = coordinator.deregister_node(HOSTILE_PEER).await;
    hostile.listening.stop();
    hostile.transport.shutdown().await;
    controller.stop().await;
}
