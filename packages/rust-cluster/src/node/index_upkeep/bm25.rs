use std::sync::Arc;

use narsil::coordination::validate_query_bm25;
use narsil::{Bm25Params, ErrorCode, Map, NarsilError, Value};

use crate::constants::{
    BM25_TUNING_SPEC_VERSION, MAX_SETTINGS_REPLACEMENT_ATTEMPTS, SETTINGS_CONTENTION_REASON,
};
use crate::controller::{
    metadata_key, metadata_with_bm25, read_index_metadata_snapshot, validate_index_name,
};
use crate::error::{ClusterError, ClusterResult, codes};
use crate::node::handle::ClusterNode;
use crate::node::index_settings::stored_bm25_settings;
use crate::node::rebalance::refuse_hidden_generation;
use crate::query::version_routing::bm25_not_ready;
use crate::reads::{HeldBm25Setting, ReadDeps};
use crate::version::reaches_version;

fn index_not_found(index_name: &str) -> ClusterError {
    ClusterError::new(
        codes::INDEX_NOT_FOUND,
        format!("Index '{index_name}' does not exist in the cluster"),
    )
    .with_detail("indexName", Value::from(index_name))
}

fn as_setting_refusal(error: NarsilError) -> ClusterError {
    if error.code() != ErrorCode::SEARCH_INVALID_FIELD {
        return ClusterError::from(error);
    }
    let mut refusal = ClusterError::new(codes::CONFIG_INVALID, error.message());
    for (key, value) in error.details().into_iter().flat_map(Map::iter) {
        refusal = refusal.with_detail(key, value.clone());
    }
    refusal
}

fn contention(index_name: &str) -> ClusterError {
    ClusterError::new(
        codes::CLUSTER_WRITE_BLOCKED,
        format!(
            "Index '{index_name}' kept changing while its BM25 setting was replaced {MAX_SETTINGS_REPLACEMENT_ATTEMPTS} times over, so the new setting was not stored. Retry the request"
        ),
    )
    .with_detail("reason", Value::from(SETTINGS_CONTENTION_REASON))
    .with_detail("indexName", Value::from(index_name))
    .with_detail("attempts", Value::from(MAX_SETTINGS_REPLACEMENT_ATTEMPTS))
}

impl ClusterNode {
    async fn replace_bm25(
        &self,
        reads: &Arc<ReadDeps>,
        index_name: &str,
        bm25: &Bm25Params,
    ) -> ClusterResult<()> {
        validate_index_name(index_name)?;
        let coordinator = self.inner.coordinator();
        let Some(schema) = coordinator.schema(index_name).await? else {
            return Err(index_not_found(index_name));
        };
        validate_query_bm25(bm25, &schema).map_err(as_setting_refusal)?;
        let stored = stored_bm25_settings(bm25);
        let older: Vec<String> = coordinator
            .list_nodes()
            .await?
            .into_iter()
            .filter(|node| !reaches_version(&node.version, BM25_TUNING_SPEC_VERSION))
            .map(|node| node.node_id)
            .collect();
        if !older.is_empty() {
            return Err(bm25_not_ready("The cluster has", older, index_name));
        }
        let key = metadata_key(index_name);
        for _ in 0..MAX_SETTINGS_REPLACEMENT_ATTEMPTS {
            let Some(current) = read_index_metadata_snapshot(coordinator, index_name).await? else {
                return Err(index_not_found(index_name));
            };
            let revision = current.bm25_revision() + 1.0;
            let next = metadata_with_bm25(&current, stored.clone(), revision)?;
            if coordinator
                .compare_and_set(&key, Some(&current.bytes), &next)
                .await?
            {
                reads
                    .bm25_view
                    .apply_written(
                        index_name,
                        HeldBm25Setting {
                            index_uuid: current.record.index_uuid.clone(),
                            bm25: stored.map(Value::Object),
                            revision: Some(revision as u64),
                        },
                    )
                    .await;
                return Ok(());
            }
        }
        Err(contention(index_name))
    }

    /// Replaces the BM25 setting of a cluster index in its metadata, so that every search that starts after the
    /// call scores under the new setting on every node. The call replaces the whole setting, so a value that it
    /// leaves out returns to its default.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` for a name that starts with `narsil-generation-`, for a malformed name, for a
    /// value out of range, or for a field that is no text field of the schema, with `INDEX_NOT_FOUND` where the
    /// cluster holds no such index, with `BM25_NOT_READY` where a registered node runs a specification version
    /// below 1.1, with `CLUSTER_WRITE_BLOCKED` where the index's metadata kept changing over 5 attempts, and with
    /// `NODE_NOT_JOINED` before the node joins or once it shuts down.
    pub async fn update_bm25(&self, index_name: &str, bm25: &Bm25Params) -> ClusterResult<()> {
        refuse_hidden_generation(index_name)?;
        let reads = self.inner.reads()?;
        self.track(
            Some(index_name),
            self.replace_bm25(&reads, index_name, bm25),
        )
        .await
    }
}
