use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use narsil::replication::decode_backup_manifest;
use narsil::{FilesystemPersistence, Map, Value};
use narsil_cluster::coordinator::etcd::{EtcdCoordinator, EtcdCoordinatorConfig};
use narsil_cluster::node::{ClusterBackupConfig, CreateBackupOptions, RestoreBackupOptions};

use crate::data_node::{
    DataNode, Scratch, coordinator_at, etcd_endpoint, eventually, metadata_key, unique_key_prefix,
};
use crate::typescript_node::{TypescriptNode, fields};

const LEDGER: &str = "ledger";
const LEDGER_COPY: &str = "ledger-copy";
const JOURNAL: &str = "journal";
const JOURNAL_COPY: &str = "journal-copy";
const DAMAGED_COPY: &str = "journal-damaged-copy";
const JOURNAL_RUST: &str = "journal-rust";
const JOURNAL_AGAIN: &str = "journal-again";
const DAMAGED_RUST_COPY: &str = "journal-again-damaged";
const LEDGER_RUST: &str = "ledger-rust";
const CONTROLLER: &str = "backup-controller";
const RUST_CONTROLLER: &str = "backup-rust-controller";
const TYPESCRIPT_DATA_NODE: &str = "backup-typescript-data";
const FIRST_RUST_NODES: [&str; 2] = ["backup-rust-data-a", "backup-rust-data-b"];
const LATER_RUST_NODES: [&str; 2] = ["backup-rust-data-c", "backup-rust-data-d"];
const KEY_PREFIX: &str = "clusters/ledger";
const PARTITION_COUNT: u64 = 3;
const DOCUMENTS: usize = 240;
const CHANGE_ROUNDS: usize = 3;
const HIDDEN_GENERATION_PREFIX: &str = "narsil-generation-";
const RESTORE_SETTLE_WAIT: Duration = Duration::from_secs(30);
const RESTORE_SETTLE_POLL: Duration = Duration::from_millis(100);

type Ledger = BTreeMap<String, (String, u64)>;

fn entry_title(document_id: &str) -> String {
    format!("ledger entry {document_id}")
}

fn entry(document_id: &str, version: u64) -> Value {
    Value::Object(fields([
        ("id", Value::from(document_id)),
        ("title", Value::from(entry_title(document_id))),
        ("version", Value::from(version)),
    ]))
}

fn files_directory(store: &Path) -> PathBuf {
    store.join(KEY_PREFIX).join("files")
}

struct MixedBackupCluster {
    coordinator: Arc<EtcdCoordinator>,
    endpoint: String,
    key_prefix: String,
    controller: Option<TypescriptNode>,
    rust_controller: Option<DataNode>,
    rust_data: Vec<DataNode>,
    store: Scratch,
    scratches: Vec<Scratch>,
}

impl MixedBackupCluster {
    async fn start() -> Option<MixedBackupCluster> {
        let endpoint = etcd_endpoint()?;
        let key_prefix = unique_key_prefix();
        let ttl = EtcdCoordinatorConfig::default().node_heartbeat_ttl_seconds;
        let coordinator = coordinator_at(endpoint.clone(), key_prefix.clone(), ttl).await;
        let store = Scratch::new();
        let controller = TypescriptNode::start_with_backups(
            (&endpoint, &key_prefix),
            CONTROLLER,
            "controller,coordinator",
            None,
            (store.path(), KEY_PREFIX),
        )
        .await;
        Some(MixedBackupCluster {
            coordinator,
            endpoint,
            key_prefix,
            controller: Some(controller),
            rust_controller: None,
            rust_data: Vec::new(),
            store,
            scratches: Vec::new(),
        })
    }

    async fn start_rust_node(&mut self, node_id: &str, roles: &[&str]) -> DataNode {
        let scratch = Scratch::new();
        let store_directory = self.store.path().to_path_buf();
        let node = DataNode::start_configured(
            &self.coordinator,
            node_id,
            scratch.path(),
            roles,
            |config| {
                config.backups = Some(ClusterBackupConfig {
                    store: Arc::new(
                        FilesystemPersistence::new(&store_directory)
                            .expect("the store directory is valid"),
                    ),
                    key_prefix: KEY_PREFIX.to_string(),
                });
            },
        )
        .await;
        self.scratches.push(scratch);
        node
    }

    async fn start_rust_data_nodes(&mut self, node_ids: [&str; 2]) {
        for node_id in node_ids {
            let node = self.start_rust_node(node_id, &["data"]).await;
            self.rust_data.push(node);
        }
    }

    async fn hand_control_to_rust(&mut self) {
        let rust_controller = self.start_rust_node(RUST_CONTROLLER, &["controller"]).await;
        if let Some(controller) = self.controller.take() {
            controller.shutdown().await;
        }
        eventually("the Rust node holds the controller lease", || async {
            rust_controller.node.is_controller()
        })
        .await;
        self.rust_controller = Some(rust_controller);
    }

    fn rust_controller(&self) -> &DataNode {
        self.rust_controller
            .as_ref()
            .expect("a Rust node holds the controller lease")
    }

    fn typescript_controller(&mut self) -> &mut TypescriptNode {
        self.controller
            .as_mut()
            .expect("the TypeScript node holds the controller lease")
    }

    async fn rust_restore(&self, backup_name: &str, index_name: &str) -> Option<String> {
        let options = RestoreBackupOptions {
            index_name: index_name.to_string(),
            replication_factor: Some(0),
            ..RestoreBackupOptions::default()
        };
        self.rust_controller()
            .node
            .restore_backup(backup_name, &options)
            .await
            .err()
            .map(|error| error.code().to_string())
    }

    async fn expect_rust_copies(&self, index_name: &str, ledger: &Ledger) {
        let generation = self.generation_of(index_name).await;
        let settled = tokio::time::timeout(RESTORE_SETTLE_WAIT, async {
            while self.rust_difference(&generation, ledger).await.is_some() {
                tokio::time::sleep(RESTORE_SETTLE_POLL).await;
            }
        })
        .await;
        if settled.is_err() {
            panic!(
                "every Rust copy of {index_name} matches its ledger: {:?}",
                self.rust_difference(&generation, ledger).await
            );
        }
    }

    async fn stop_rust_data_nodes(&mut self) {
        for node in self.rust_data.drain(..) {
            node.stop().await;
        }
    }

    async fn start_typescript_data_node(&mut self) -> TypescriptNode {
        let scratch = Scratch::new();
        let node = TypescriptNode::start_with_backups(
            (&self.endpoint, &self.key_prefix),
            TYPESCRIPT_DATA_NODE,
            "data",
            Some(scratch.path()),
            (self.store.path(), KEY_PREFIX),
        )
        .await;
        self.scratches.push(scratch);
        node
    }

    async fn call(&mut self, operation: &str, request: Map) -> Value {
        self.typescript_controller()
            .call(operation, request)
            .await
            .value()
    }

    async fn create_index(&mut self, index_name: &str) {
        let schema = Value::Object(fields([
            ("title", Value::from("string")),
            ("version", Value::from("number")),
        ]));
        self.typescript_controller()
            .create_index_with_schema(index_name, PARTITION_COUNT, 1, schema, Map::new())
            .await;
    }

    async fn write_ledger(&mut self, index_name: &str) -> Ledger {
        let documents: Vec<Value> = (0..DOCUMENTS)
            .map(|at| entry(&format!("doc-{at}"), 1))
            .collect();
        let outcome = self
            .call(
                "insertBatch",
                fields([
                    ("indexName", Value::from(index_name)),
                    ("documents", Value::Array(documents)),
                ]),
            )
            .await;
        assert_eq!(
            outcome.as_object().and_then(|fields| fields.get("failed")),
            Some(&Value::Array(Vec::new())),
            "every opening write is acknowledged"
        );
        (0..DOCUMENTS)
            .map(|at| {
                let id = format!("doc-{at}");
                (id.clone(), (entry_title(&id), 1))
            })
            .collect()
    }

    async fn change(&mut self, index_name: &str, ledger: &mut Ledger) {
        for round in 0..CHANGE_ROUNDS {
            for at in (round..DOCUMENTS).step_by(7) {
                let id = format!("doc-{at}");
                if at % 3 == 0 {
                    self.typescript_controller()
                        .remove(index_name, &id)
                        .await
                        .value();
                    ledger.remove(&id);
                } else if ledger.contains_key(&id) {
                    let version = round as u64 + 2;
                    let document = entry(&id, version);
                    self.call(
                        "update",
                        fields([
                            ("indexName", Value::from(index_name)),
                            ("documentId", Value::from(id.as_str())),
                            ("document", document),
                        ]),
                    )
                    .await;
                    ledger.insert(id.clone(), (entry_title(&id), version));
                }
            }
        }
    }

    async fn primaries_of(&self, index_name: &str) -> Vec<String> {
        let table = self
            .coordinator
            .allocation(index_name)
            .await
            .expect("etcd answers for the table")
            .expect("the index has a table");
        table
            .assignments
            .iter()
            .filter_map(|(_, assignment)| assignment.get("primary").and_then(Value::as_str))
            .map(str::to_string)
            .collect()
    }

    async fn create_backup(&mut self, index_name: &str, backup_name: &str) {
        self.call(
            "createBackup",
            fields([
                ("indexName", Value::from(index_name)),
                ("backupName", Value::from(backup_name)),
            ]),
        )
        .await;
    }

    async fn delete_backup(&mut self, backup_name: &str) {
        self.call(
            "deleteBackup",
            fields([("backupName", Value::from(backup_name))]),
        )
        .await;
    }

    async fn restore(&mut self, backup_name: &str, index_name: &str) -> Option<String> {
        let request = fields([
            ("backupName", Value::from(backup_name)),
            ("indexName", Value::from(index_name)),
            ("replicationFactor", Value::from(0)),
        ]);
        self.typescript_controller()
            .call("restoreBackup", request)
            .await
            .code()
            .map(str::to_string)
    }

    async fn typescript_difference(&mut self, index_name: &str, ledger: &Ledger) -> Option<String> {
        let ids: Vec<Value> = (0..DOCUMENTS)
            .map(|at| Value::from(format!("doc-{at}")))
            .collect();
        let Value::Object(stored) = self
            .call(
                "getMultiple",
                fields([
                    ("indexName", Value::from(index_name)),
                    ("documentIds", Value::Array(ids)),
                ]),
            )
            .await
        else {
            panic!("the TypeScript nodes read the restored documents");
        };
        for at in 0..DOCUMENTS {
            let id = format!("doc-{at}");
            let held = stored
                .get(id.as_str())
                .and_then(Value::as_object)
                .map(|document| {
                    let title = document
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let version = document
                        .get("version")
                        .and_then(Value::as_f64)
                        .unwrap_or(-1.0);
                    (title.to_string(), version)
                });
            let wanted = ledger
                .get(&id)
                .map(|(title, version)| (title.clone(), *version as f64));
            if held != wanted {
                return Some(format!("{id}: held {held:?}, wanted {wanted:?}"));
            }
        }
        let counted: u64 = self
            .typescript_controller()
            .partition_counts(index_name)
            .await
            .iter()
            .map(|(_, count)| count)
            .sum();
        (counted != ledger.len() as u64).then(|| {
            format!(
                "the index counts {counted} documents where the ledger holds {}",
                ledger.len()
            )
        })
    }

    async fn rust_difference(&self, generation: &str, ledger: &Ledger) -> Option<String> {
        for at in 0..DOCUMENTS {
            let id = format!("doc-{at}");
            let wanted = ledger
                .get(&id)
                .map(|(title, version)| (title.clone(), *version as f64));
            let mut found = Vec::new();
            for data in &self.rust_data {
                let held = match data.node.local_document(generation, &id).await {
                    Ok(held) => held,
                    Err(error) if error.code() == "INDEX_NOT_FOUND" => continue,
                    Err(error) => panic!("a Rust node reads its copy of {id}: {error:?}"),
                };
                if let Some(document) = held {
                    let title = document
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let version = document
                        .get("version")
                        .and_then(Value::as_f64)
                        .unwrap_or(-1.0);
                    found.push((title.to_string(), version));
                }
            }
            let whole = match &wanted {
                Some(wanted) => !found.is_empty() && found.iter().all(|held| held == wanted),
                None => found.is_empty(),
            };
            if !whole {
                return Some(format!("{id}: held {found:?}, wanted {wanted:?}"));
            }
        }
        None
    }

    async fn generation_of(&self, index_name: &str) -> String {
        self.coordinator
            .allocation(index_name)
            .await
            .expect("etcd answers for the table")
            .and_then(|table| table.generation)
            .expect("the restored name points at its generation")
    }

    async fn stray_generations(&self) -> Vec<String> {
        let schemas = self
            .coordinator
            .list_schemas()
            .await
            .expect("etcd lists the schemas");
        let mut served = BTreeSet::new();
        for name in schemas
            .iter()
            .filter(|name| !name.starts_with(HIDDEN_GENERATION_PREFIX))
        {
            let table = self
                .coordinator
                .allocation(name)
                .await
                .expect("etcd answers for the table");
            if let Some(generation) = table.and_then(|table| table.generation) {
                served.insert(generation);
            }
        }
        schemas
            .into_iter()
            .filter(|name| name.starts_with(HIDDEN_GENERATION_PREFIX) && !served.contains(name))
            .collect()
    }

    async fn expect_no_index(&self, index_name: &str) {
        let metadata = self
            .coordinator
            .get(&metadata_key(index_name))
            .await
            .expect("etcd answers");
        assert!(
            metadata.is_none_or(|bytes| bytes.is_empty()),
            "{index_name} has no metadata"
        );
        assert!(
            self.coordinator
                .schema(index_name)
                .await
                .expect("etcd answers")
                .is_none()
        );
        assert!(
            self.coordinator
                .allocation(index_name)
                .await
                .expect("etcd answers")
                .is_none()
        );
        assert_eq!(self.stray_generations().await, Vec::<String>::new());
    }

    fn flip_first_file_of_each_partition(&self, backup_name: &str) -> Vec<(PathBuf, Vec<u8>)> {
        let manifest_path = self
            .store
            .path()
            .join(KEY_PREFIX)
            .join("backups")
            .join(backup_name);
        let manifest = decode_backup_manifest(
            &std::fs::read(&manifest_path).expect("the manifest is stored"),
            backup_name,
        )
        .expect("the manifest decodes");
        let mut flipped = BTreeMap::new();
        for partition in &manifest.partitions {
            let Some(listed) = partition.files.first() else {
                continue;
            };
            let path = files_directory(self.store.path()).join(&listed.file.sha256);
            if flipped.contains_key(&path) {
                continue;
            }
            let original = std::fs::read(&path).expect("the listed file is stored");
            let mut bytes = original.clone();
            let middle = bytes.len() / 2;
            bytes[middle] ^= 0xff;
            std::fs::write(&path, bytes).expect("the stored file takes the flipped byte");
            flipped.insert(path, original);
        }
        flipped.into_iter().collect()
    }

    async fn stop(mut self) {
        self.stop_rust_data_nodes().await;
        if let Some(rust_controller) = self.rust_controller.take() {
            rust_controller.stop().await;
        }
        if let Some(controller) = self.controller.take() {
            controller.shutdown().await;
        }
        self.coordinator.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_backup_that_one_language_takes_restores_whole_in_the_other() {
    let Some(mut cluster) = MixedBackupCluster::start().await else {
        return;
    };
    cluster.start_rust_data_nodes(FIRST_RUST_NODES).await;
    cluster.create_index(LEDGER).await;
    let primaries = cluster.primaries_of(LEDGER).await;
    assert!(
        primaries
            .iter()
            .all(|primary| FIRST_RUST_NODES.contains(&primary.as_str()))
    );
    let mut ledger = cluster.write_ledger(LEDGER).await;
    cluster.create_backup(LEDGER, "first").await;
    cluster.create_backup(LEDGER, "unchanged").await;
    cluster.delete_backup("unchanged").await;
    cluster.change(LEDGER, &mut ledger).await;
    cluster.create_backup(LEDGER, "second").await;
    cluster.delete_backup("first").await;

    cluster.stop_rust_data_nodes().await;
    let typescript_data = cluster.start_typescript_data_node().await;
    assert_eq!(cluster.restore("second", LEDGER_COPY).await, None);
    assert_eq!(
        cluster.typescript_difference(LEDGER_COPY, &ledger).await,
        None
    );

    cluster.create_index(JOURNAL).await;
    let mut journal = cluster.write_ledger(JOURNAL).await;
    cluster.change(JOURNAL, &mut journal).await;
    cluster.create_backup(JOURNAL, "journal").await;
    typescript_data.shutdown().await;
    cluster.start_rust_data_nodes(LATER_RUST_NODES).await;

    let flipped = cluster.flip_first_file_of_each_partition("journal");
    assert_eq!(
        cluster.restore("journal", DAMAGED_COPY).await.as_deref(),
        Some("BACKUP_DAMAGED")
    );
    cluster.expect_no_index(DAMAGED_COPY).await;
    for (path, original) in flipped {
        std::fs::write(path, original).expect("the stored file takes its original bytes back");
    }

    assert_eq!(cluster.restore("journal", JOURNAL_COPY).await, None);
    cluster.expect_rust_copies(JOURNAL_COPY, &journal).await;

    cluster.hand_control_to_rust().await;
    assert_eq!(cluster.rust_restore("journal", JOURNAL_RUST).await, None);
    cluster.expect_rust_copies(JOURNAL_RUST, &journal).await;
    let again = cluster
        .rust_controller()
        .node
        .create_backup(
            JOURNAL_RUST,
            "journal-again",
            &CreateBackupOptions::default(),
        )
        .await
        .expect("the Rust controller backs up a restored index");
    assert_eq!(again.partition_count, PARTITION_COUNT);
    cluster
        .rust_controller()
        .node
        .delete_backup("journal", None)
        .await
        .expect("the Rust controller deletes a backup");

    let flipped = cluster.flip_first_file_of_each_partition("journal-again");
    assert_eq!(
        cluster
            .rust_restore("journal-again", DAMAGED_RUST_COPY)
            .await
            .as_deref(),
        Some("BACKUP_DAMAGED")
    );
    cluster.expect_no_index(DAMAGED_RUST_COPY).await;
    for (path, original) in flipped {
        std::fs::write(path, original).expect("the stored file takes its original bytes back");
    }
    assert_eq!(
        cluster.rust_restore("journal-again", JOURNAL_AGAIN).await,
        None
    );
    cluster.expect_rust_copies(JOURNAL_AGAIN, &journal).await;
    assert_eq!(cluster.rust_restore("second", LEDGER_RUST).await, None);
    cluster.expect_rust_copies(LEDGER_RUST, &ledger).await;
    assert_eq!(cluster.stray_generations().await, Vec::<String>::new());
    cluster.stop().await;
}
