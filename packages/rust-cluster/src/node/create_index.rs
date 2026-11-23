use std::time::{Duration, Instant};

use narsil::{
    AdapterSetting, IndexConfig, Map, Narsil, NarsilConfig, PartitionConfig,
    QuerySuggestionsSource, StopWordsSetting, TokenizerSetting, Value, encode_msgpack,
};

use super::handle::ClusterNode;
use super::identity::generate_node_id;
use super::index_settings::{encoded_synonym_rules, index_settings_of, sets_field_pairs};
use super::rebalance::refuse_hidden_generation;
use crate::constants::{
    BM25_TUNING_SPEC_VERSION, DEFAULT_CREATE_INDEX_WAIT_MS, DEFAULT_PARTITION_COUNT,
    DEFAULT_REPLICATION_FACTOR, DEFAULT_ZONE_ATTRIBUTE, DROP_ACKNOWLEDGE_POLL_INTERVAL_MS,
    MAX_DROP_ACKNOWLEDGE_WAIT_MS, MAX_PARTITION_COUNT, MAX_REPLICATION_FACTOR,
};
use crate::controller::{index_metadata, metadata_key, validate_index_name};
use crate::data::blocking::off_executor;
use crate::data::synonym_set::{
    SynonymSetRef, delete_synonym_set, store_synonym_set, synonym_set_ref_value,
};
use crate::error::{ClusterError, ClusterResult, codes};
use crate::version::reaches_version;

/// How a cluster spreads a new index across its nodes, and how long the create waits for the index to serve.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CreateIndexOptions {
    /// The number of partitions, 5 by default and from 1 to 65,536.
    pub partition_count: Option<u32>,
    /// The number of replicas of each partition beside its primary, 1 by default and from 0 to 255.
    pub replication_factor: Option<u32>,
    /// How many milliseconds the create waits for every partition to serve, 30,000 by default, where 0 returns as
    /// soon as the index is recorded.
    pub wait_for_serving_ms: Option<u64>,
}

fn options_invalid(message: String, key: &str, value: u32) -> ClusterError {
    ClusterError::new(codes::CONFIG_INVALID, message).with_detail(key, Value::from(value))
}

fn validate_create_index_options(
    partition_count: u32,
    replication_factor: u32,
) -> ClusterResult<()> {
    if partition_count < 1 || f64::from(partition_count) > MAX_PARTITION_COUNT {
        return Err(options_invalid(
            format!(
                "partitionCount must be an integer between 1 and {MAX_PARTITION_COUNT}, received {partition_count}"
            ),
            "partitionCount",
            partition_count,
        ));
    }
    if f64::from(replication_factor) > MAX_REPLICATION_FACTOR {
        return Err(options_invalid(
            format!(
                "replicationFactor must be an integer between 0 and {MAX_REPLICATION_FACTOR}, received {replication_factor}"
            ),
            "replicationFactor",
            replication_factor,
        ));
    }
    Ok(())
}

fn with_partition_count(mut config: IndexConfig, partition_count: u32) -> IndexConfig {
    let mut partitions: PartitionConfig = config.partitions.unwrap_or_default();
    partitions.max_partitions = Some(u64::from(partition_count));
    config.partitions = Some(partitions);
    config
}

fn without_registered_names(mut config: IndexConfig) -> IndexConfig {
    let mut named = false;
    if matches!(config.tokenizer, Some(TokenizerSetting::Named(_))) {
        config.tokenizer = None;
        named = true;
    }
    if matches!(config.stop_words, Some(StopWordsSetting::Named(_))) {
        config.stop_words = None;
        named = true;
    }
    let names_adapter = config
        .embedding
        .as_ref()
        .is_some_and(|embedding| matches!(embedding.adapter, Some(AdapterSetting::Named(_))));
    if names_adapter {
        config.embedding = None;
    }
    if named {
        config.synonyms = None;
    }
    config
}

fn canonical_schema_without_engine(index_name: &str, config: IndexConfig) -> ClusterResult<Value> {
    let engine = Narsil::open(NarsilConfig::default())?;
    let created = engine
        .create_index(index_name, without_registered_names(config))
        .and_then(|()| engine.get_stats(index_name))
        .map(|stats| stats.schema);
    let _ = engine.shutdown();
    Ok(created?)
}

fn constraints() -> Value {
    let mut constraints = Map::with_capacity(3);
    constraints.insert("zoneAwareness", Value::Bool(false));
    constraints.insert("zoneAttribute", Value::from(DEFAULT_ZONE_ATTRIBUTE));
    constraints.insert("maxShardsPerNode", Value::Null);
    Value::Object(constraints)
}

struct NewIndex<'a> {
    index_name: &'a str,
    index_uuid: String,
    partition_count: u32,
    replication_factor: u32,
    settings: Map,
}

fn metadata_record(index: &NewIndex<'_>) -> ClusterResult<Vec<u8>> {
    let mut record = Map::with_capacity(6);
    record.insert("indexUuid", Value::from(index.index_uuid.as_str()));
    record.insert("indexName", Value::from(index.index_name));
    record.insert("partitionCount", Value::from(index.partition_count));
    record.insert("replicationFactor", Value::from(index.replication_factor));
    record.insert("constraints", constraints());
    record.insert("settings", Value::Object(index.settings.clone()));
    Ok(encode_msgpack(&Value::Object(record))?)
}

impl ClusterNode {
    async fn put_index_metadata(&self, index_name: &str, bytes: &[u8]) -> ClusterResult<bool> {
        let coordinator = self.inner.coordinator();
        let key = metadata_key(index_name);
        if coordinator.compare_and_set(&key, None, bytes).await? {
            return Ok(true);
        }
        match coordinator.get(&key).await? {
            Some(current) if current.is_empty() => {
                coordinator
                    .compare_and_set(&key, Some(&current), bytes)
                    .await
            }
            _ => Ok(false),
        }
    }

    async fn discard_synonym_set(&self, index_uuid: &str, reference: Option<&SynonymSetRef>) {
        if let Some(reference) = reference {
            let _ = delete_synonym_set(self.inner.coordinator(), index_uuid, reference).await;
        }
    }

    pub(in crate::node) async fn await_torn_down_copy(
        &self,
        index_name: &str,
    ) -> ClusterResult<()> {
        let Some(data) = &self.inner.data else {
            return Ok(());
        };
        let deadline = Instant::now() + Duration::from_millis(MAX_DROP_ACKNOWLEDGE_WAIT_MS);
        while data.lists_local_index(index_name).await? && Instant::now() < deadline {
            if index_metadata(self.inner.coordinator(), index_name)
                .await?
                .is_some()
            {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(DROP_ACKNOWLEDGE_POLL_INTERVAL_MS)).await;
        }
        Ok(())
    }

    async fn create_local_copy(
        &self,
        index: &NewIndex<'_>,
        config: IndexConfig,
    ) -> ClusterResult<Value> {
        let config = with_partition_count(config, index.partition_count);
        match &self.inner.data {
            Some(data) => {
                data.create_local_index(
                    index.index_name,
                    config,
                    &index.index_uuid,
                    index.partition_count,
                )
                .await
            }
            None => {
                let name = index.index_name.to_string();
                off_executor(move || canonical_schema_without_engine(&name, config)).await?
            }
        }
    }

    async fn withdraw_partial_index(&self, index_name: &str) -> ClusterResult<()> {
        let coordinator = self.inner.coordinator();
        let key = metadata_key(index_name);
        if let Some(current) = coordinator.get(&key).await?
            && !current.is_empty()
            && coordinator
                .compare_and_set(&key, Some(&current), &[])
                .await?
        {
            self.delete_stored_synonym_set(&current).await?;
        }
        coordinator.drop_schema(index_name).await?;
        if let Some(data) = &self.inner.data {
            data.drop_local_index(index_name, true).await?;
        }
        Ok(())
    }

    async fn require_bm25_tuning_nodes(&self, index_name: &str) -> ClusterResult<()> {
        let mut older: Vec<String> = self
            .inner
            .coordinator()
            .list_nodes()
            .await?
            .into_iter()
            .filter(|node| !reaches_version(&node.version, BM25_TUNING_SPEC_VERSION))
            .map(|node| node.node_id)
            .collect();
        if older.is_empty() {
            return Ok(());
        }
        older.sort();
        Err(ClusterError::new(
            codes::BM25_NOT_READY,
            format!(
                "The cluster has {} node(s) below specification version {BM25_TUNING_SPEC_VERSION}, which cannot use BM25 parameters that the index or the search sets. Try again once every node registers that version",
                older.len()
            ),
        )
        .with_detail("indexName", Value::from(index_name))
        .with_detail(
            "nodeIds",
            Value::Array(older.into_iter().map(Value::String).collect()),
        )
        .with_detail("minimumVersion", Value::from(BM25_TUNING_SPEC_VERSION)))
    }

    async fn record_new_index(
        &self,
        index: &NewIndex<'_>,
        synonyms: Option<&SynonymSetRef>,
    ) -> ClusterResult<()> {
        let stored = match metadata_record(index) {
            Ok(bytes) => self.put_index_metadata(index.index_name, &bytes).await,
            Err(error) => Err(error),
        };
        match stored {
            Ok(true) => Ok(()),
            Ok(false) => {
                self.discard_synonym_set(&index.index_uuid, synonyms).await;
                Err(ClusterError::new(
                    codes::INDEX_ALREADY_EXISTS,
                    format!(
                        "Index '{}' already exists in the cluster or a partial creation is pending",
                        index.index_name
                    ),
                )
                .with_detail("indexName", Value::from(index.index_name)))
            }
            Err(error) => {
                self.discard_synonym_set(&index.index_uuid, synonyms).await;
                Err(error)
            }
        }
    }

    async fn publish_new_index(
        &self,
        index: &NewIndex<'_>,
        config: IndexConfig,
    ) -> ClusterResult<()> {
        let created = match self.create_local_copy(index, config).await {
            Ok(schema) => {
                self.inner
                    .coordinator()
                    .put_schema(index.index_name, &schema)
                    .await
            }
            Err(error) => Err(error),
        };
        let Err(create_error) = created else {
            return Ok(());
        };
        if let Err(cleanup_error) = self.withdraw_partial_index(index.index_name).await {
            return Err(ClusterError::new(
                codes::CONFIG_INVALID,
                format!(
                    "Index creation for '{}' failed and the withdrawal of its cluster metadata also failed. The index may be in a partial state and require manual intervention.",
                    index.index_name
                ),
            )
            .with_detail("indexName", Value::from(index.index_name))
            .with_detail("createError", Value::from(create_error.message()))
            .with_detail("cleanupError", Value::from(cleanup_error.message())));
        }
        Err(create_error)
    }

    pub(in crate::node) async fn route_create_index(
        &self,
        index_name: &str,
        config: IndexConfig,
        options: &CreateIndexOptions,
        marker: Option<&QuerySuggestionsSource>,
    ) -> ClusterResult<()> {
        validate_index_name(index_name)?;
        let sets_pairs = sets_field_pairs(config.bm25.as_ref());
        if sets_pairs {
            self.require_bm25_tuning_nodes(index_name).await?;
        }
        let partition_count = options.partition_count.unwrap_or(DEFAULT_PARTITION_COUNT);
        let replication_factor = options
            .replication_factor
            .unwrap_or(DEFAULT_REPLICATION_FACTOR);
        validate_create_index_options(partition_count, replication_factor)?;
        let mut settings = index_settings_of(&config)?;
        let encoded_synonyms = encoded_synonym_rules(&config)?;
        let index_uuid = generate_node_id()?;
        let synonyms = match &encoded_synonyms {
            Some(encoded) => {
                Some(store_synonym_set(self.inner.coordinator(), &index_uuid, encoded).await?)
            }
            None => None,
        };
        if let Some(reference) = &synonyms {
            settings.insert("synonyms", synonym_set_ref_value(reference));
        }
        if sets_pairs {
            settings.insert("bm25Revision", Value::from(1u32));
        }
        if let Some(source) = marker {
            let mut wire = Map::new();
            wire.insert("index", Value::from(source.index.as_str()));
            wire.insert("group", Value::from(source.group.as_str()));
            settings.insert("querySuggestionsSource", Value::Object(wire));
        }
        let index = NewIndex {
            index_name,
            index_uuid,
            partition_count,
            replication_factor,
            settings,
        };
        self.record_new_index(&index, synonyms.as_ref()).await?;
        self.publish_new_index(&index, config).await?;
        let wait_ms = options
            .wait_for_serving_ms
            .unwrap_or(DEFAULT_CREATE_INDEX_WAIT_MS);
        self.wait_for_serving_allocation(index_name, partition_count, wait_ms)
            .await;
        Ok(())
    }

    /// Creates an index across the cluster: records its metadata and schema, creates the local copy on a node with
    /// the `data` role, and returns once the controller brings every partition into service or the wait in
    /// `options` passes.
    ///
    /// The node stores a tokenizer, a stop word set, and an embedding adapter by their registered names, and stores
    /// a synonym set in chunks beside the metadata. Where the local copy cannot be created, the node withdraws the
    /// metadata, the schema, and the synonym set that it wrote. A node without the `data` role checks the settings
    /// in a short-lived in-memory engine that holds no registered names, so a data node that cannot resolve a name
    /// refuses its copy later.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` for a name that starts with `narsil-generation-`, for a partition count outside
    /// 1 to 65,536, for a replication factor above 255, and for a tokenizer, stop word function, or embedding
    /// adapter given as code, with `CONTROLLER_METADATA_INVALID` for a name that the cluster cannot store, with
    /// `INDEX_ORPHANED` where this node keeps an orphaned copy under that name, with `BM25_NOT_READY` where the index
    /// sets per-field BM25 parameters while a registered node runs a specification version below 1.1, with
    /// `INDEX_ALREADY_EXISTS` where the cluster holds that name, with the engine's error for a schema or a setting
    /// that it refuses, and with `NODE_NOT_JOINED` after shutdown.
    pub async fn create_index(
        &self,
        index_name: &str,
        config: IndexConfig,
        options: CreateIndexOptions,
    ) -> ClusterResult<()> {
        refuse_hidden_generation(index_name)?;
        self.guard_shutdown()?;
        if let Some(data) = &self.inner.data {
            data.refuse_orphaned_name(index_name)?;
        }
        self.await_torn_down_copy(index_name).await?;
        self.clear_leftovers_of_name(index_name).await?;
        self.route_create_index(index_name, config, &options, None)
            .await
    }
}
