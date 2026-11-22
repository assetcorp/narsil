use std::collections::{BTreeSet, HashSet};
use std::sync::Mutex;

use narsil::replication::{CopyPosition, PartitionCopies};
use narsil::{ErrorCode, IndexConfig, Map, Narsil, NarsilError, Value};

use super::config::DataNodeConfig;
use crate::controller::lock;
use crate::error::{ClusterError, ClusterResult, codes};

pub(super) struct LocalCopies {
    node_id: String,
    pub(super) engine: Narsil,
    orphaned: Mutex<HashSet<String>>,
    unreadable: Mutex<HashSet<String>>,
    explicit_drop: Mutex<()>,
    held_record: Mutex<()>,
}

pub(super) struct StoredPartitions {
    pub(super) index_uuid: Option<String>,
    pub(super) partition_ids: Vec<u32>,
}

fn unless_gone(outcome: narsil::Result<()>) -> ClusterResult<()> {
    match outcome {
        Err(error) if error.code() == ErrorCode::INDEX_NOT_FOUND => Ok(()),
        other => Ok(other?),
    }
}

impl LocalCopies {
    pub(super) fn open(node_id: String, config: DataNodeConfig) -> ClusterResult<LocalCopies> {
        let DataNodeConfig {
            engine,
            tokenizers,
            stop_words,
            embedding_adapters,
            rerank_adapters,
        } = config;
        let engine = Narsil::open_with(engine, move |engine| {
            for (name, tokenizer) in tokenizers {
                engine.register_tokenizer(&name, tokenizer)?;
            }
            for (name, words) in stop_words {
                engine.register_stop_words(&name, words)?;
            }
            for (name, adapter) in embedding_adapters {
                engine.register_embedding_adapter(&name, adapter)?;
            }
            for (name, adapter) in rerank_adapters {
                engine.register_rerank_adapter(&name, adapter)?;
            }
            Ok(())
        })?;
        Ok(LocalCopies {
            node_id,
            engine,
            orphaned: Mutex::new(HashSet::new()),
            unreadable: Mutex::new(HashSet::new()),
            explicit_drop: Mutex::new(()),
            held_record: Mutex::new(()),
        })
    }

    pub(super) fn holds_index(&self, index_name: &str) -> bool {
        self.engine
            .list_indexes()
            .iter()
            .any(|index| index.name == index_name)
    }

    pub(super) fn local_uuid(&self, index_name: &str) -> ClusterResult<Option<String>> {
        if !self.holds_index(index_name) {
            return Ok(None);
        }
        match PartitionCopies::new(&self.engine).index_uuid(index_name) {
            Err(error) if error.code() == ErrorCode::INDEX_NOT_FOUND => Ok(None),
            other => Ok(other?),
        }
    }

    pub(super) fn create_copy(
        &self,
        index_name: &str,
        config: IndexConfig,
        index_uuid: &str,
        partition_count: u32,
    ) -> ClusterResult<()> {
        self.refuse_orphaned(index_name)?;
        let created = PartitionCopies::new(&self.engine).create_index(
            index_name,
            config,
            index_uuid,
            partition_count,
        );
        match created {
            Err(error) if error.code() == ErrorCode::INDEX_ALREADY_EXISTS => Ok(()),
            other => Ok(other?),
        }
    }

    pub(super) fn schema_of(&self, index_name: &str) -> Result<Value, NarsilError> {
        Ok(self.engine.get_stats(index_name)?.schema)
    }

    pub(super) fn ready_primary(
        &self,
        index_name: &str,
        index_uuid: &str,
        partition_id: u32,
        floor: Option<CopyPosition>,
    ) -> ClusterResult<()> {
        self.refuse_orphaned(index_name)?;
        let copies = PartitionCopies::new(&self.engine);
        if copies.index_uuid(index_name)?.is_none() {
            copies.adopt(index_name, index_uuid)?;
        }
        if let Some(floor) = floor.filter(|floor| floor.seq_no > 0) {
            copies.advance(index_name, partition_id, floor)?;
        }
        self.hold_partition(index_name, partition_id)
    }

    pub(super) fn drop_copy_of(&self, index_name: &str, index_uuid: &str) -> ClusterResult<()> {
        if self.is_orphaned(index_name)
            || self.local_uuid(index_name)?.as_deref() != Some(index_uuid)
        {
            return Ok(());
        }
        self.drop_copy(index_name)
    }

    pub(super) fn partitions_without_copy(
        &self,
        index_name: &str,
        index_uuid: &str,
        assigned: &[u32],
    ) -> ClusterResult<Vec<u32>> {
        if self.is_orphaned(index_name)
            || self.local_uuid(index_name)?.as_deref() != Some(index_uuid)
        {
            return Ok(assigned.to_vec());
        }
        let copies = PartitionCopies::new(&self.engine);
        let Some(recorded) = copies.held_partitions(index_name)? else {
            return Ok(Vec::new());
        };
        if assigned
            .iter()
            .all(|partition_id| recorded.contains(partition_id))
        {
            return Ok(Vec::new());
        }
        let mut listed: BTreeSet<u32> = recorded.into_iter().collect();
        listed.extend(copies.partitions_with_data(index_name)?);
        Ok(assigned
            .iter()
            .filter(|partition_id| !listed.contains(partition_id))
            .copied()
            .collect())
    }

    pub(super) fn held_partition_ids(&self, index_name: &str) -> ClusterResult<Vec<u32>> {
        if self.is_orphaned(index_name) || !self.holds_index(index_name) {
            return Ok(Vec::new());
        }
        match PartitionCopies::new(&self.engine).held_partitions(index_name) {
            Ok(held) => Ok(held.unwrap_or_default()),
            Err(error) if error.code() == ErrorCode::INDEX_NOT_FOUND => Ok(Vec::new()),
            Err(error) => Err(error.into()),
        }
    }

    fn change_held(
        &self,
        index_name: &str,
        change: impl FnOnce(&mut BTreeSet<u32>),
    ) -> ClusterResult<()> {
        let _turn = lock(&self.held_record);
        let copies = PartitionCopies::new(&self.engine);
        let mut held: BTreeSet<u32> = match copies.held_partitions(index_name) {
            Ok(held) => held.unwrap_or_default().into_iter().collect(),
            Err(error) if error.code() == ErrorCode::INDEX_NOT_FOUND => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        change(&mut held);
        let held: Vec<u32> = held.into_iter().collect();
        unless_gone(copies.record_held_partitions(index_name, &held))
    }

    pub(super) fn hold_partition(&self, index_name: &str, partition_id: u32) -> ClusterResult<()> {
        self.change_held(index_name, |held| {
            held.insert(partition_id);
        })
    }

    pub(super) fn forget_partition(
        &self,
        index_name: &str,
        partition_id: u32,
    ) -> ClusterResult<()> {
        self.change_held(index_name, |held| {
            held.remove(&partition_id);
        })
    }

    fn drop_copy(&self, index_name: &str) -> ClusterResult<()> {
        unless_gone(self.engine.drop_index(index_name))
    }

    pub(super) fn stored_partitions(&self, index_name: &str) -> ClusterResult<StoredPartitions> {
        let absent = StoredPartitions {
            index_uuid: None,
            partition_ids: Vec::new(),
        };
        if self.is_orphaned(index_name) || !self.holds_index(index_name) {
            return Ok(absent);
        }
        let copies = PartitionCopies::new(&self.engine);
        let index_uuid = match copies.index_uuid(index_name) {
            Ok(Some(index_uuid)) => index_uuid,
            Ok(None) => return Ok(absent),
            Err(error) if error.code() == ErrorCode::INDEX_NOT_FOUND => return Ok(absent),
            Err(error) => return Err(error.into()),
        };
        let mut listed: BTreeSet<u32> = copies
            .held_partitions(index_name)?
            .unwrap_or_default()
            .into_iter()
            .collect();
        listed.extend(copies.partitions_with_data(index_name)?);
        let mut partition_ids = Vec::with_capacity(listed.len());
        for partition_id in listed {
            if copies.failure(index_name, partition_id)?.is_none() {
                partition_ids.push(partition_id);
            }
        }
        Ok(StoredPartitions {
            index_uuid: Some(index_uuid),
            partition_ids,
        })
    }

    pub(super) fn close(&self) -> ClusterResult<()> {
        Ok(self.engine.shutdown()?)
    }

    pub(super) fn index_names(&self) -> Vec<String> {
        self.engine
            .list_indexes()
            .into_iter()
            .map(|index| index.name)
            .collect()
    }

    pub(super) fn index_uuid(&self, index_name: &str) -> ClusterResult<Option<String>> {
        Ok(PartitionCopies::new(&self.engine).index_uuid(index_name)?)
    }

    pub(super) fn adopt(&self, index_name: &str, index_uuid: &str) -> ClusterResult<()> {
        Ok(PartitionCopies::new(&self.engine).adopt(index_name, index_uuid)?)
    }

    pub(super) fn apply_stored_settings(
        &self,
        index_name: &str,
        index_uuid: &str,
        config: &IndexConfig,
    ) -> ClusterResult<()> {
        if self.index_uuid(index_name)?.as_deref() != Some(index_uuid) {
            return Ok(());
        }
        let rules = config.synonyms.as_deref().unwrap_or_default();
        self.engine.update_synonyms(index_name, rules)?;
        let bm25 = config.bm25.clone().unwrap_or_default();
        Ok(self.engine.update_bm25(index_name, &bm25)?)
    }

    pub(super) fn drop_superseded(&self, index_name: &str) -> ClusterResult<()> {
        Ok(self.engine.drop_index(index_name)?)
    }

    pub(super) fn mark_orphaned(&self, index_name: &str, unreadable: bool) {
        lock(&self.orphaned).insert(index_name.to_string());
        let mut unreadable_names = lock(&self.unreadable);
        if unreadable {
            unreadable_names.insert(index_name.to_string());
        } else {
            unreadable_names.remove(index_name);
        }
    }

    pub(super) fn forget_orphan(&self, index_name: &str) {
        lock(&self.orphaned).remove(index_name);
        lock(&self.unreadable).remove(index_name);
    }

    pub(super) fn unreadable_names(&self) -> Vec<String> {
        let mut names: Vec<String> = lock(&self.unreadable).iter().cloned().collect();
        names.sort();
        names
    }

    pub(super) fn is_orphaned(&self, index_name: &str) -> bool {
        lock(&self.orphaned).contains(index_name)
    }

    pub(super) fn refuse_orphaned(&self, index_name: &str) -> ClusterResult<()> {
        if !self.is_orphaned(index_name) {
            return Ok(());
        }
        let node_id = &self.node_id;
        Err(ClusterError::new(
            codes::INDEX_ORPHANED,
            format!(
                "Node '{node_id}' holds a local copy of index '{index_name}' the cluster does not claim, so it \
                 answers nothing for that name. Drop it to reclaim the space"
            ),
        )
        .with_detail("indexName", Value::String(index_name.to_string()))
        .with_detail("nodeId", Value::String(node_id.clone())))
    }

    pub(super) fn document(
        &self,
        index_name: &str,
        document_id: &str,
    ) -> ClusterResult<Option<Map>> {
        self.refuse_orphaned(index_name)?;
        Ok(PartitionCopies::new(&self.engine).document(index_name, document_id)?)
    }

    pub(super) fn drop_orphaned(&self, index_name: &str) -> ClusterResult<()> {
        let _turn = lock(&self.explicit_drop);
        if !self.is_orphaned(index_name) {
            let node_id = &self.node_id;
            return Err(ClusterError::new(
                codes::CONFIG_INVALID,
                format!(
                    "Node '{node_id}' holds no orphaned copy of index '{index_name}', and only an orphaned copy \
                     can be dropped from one node"
                ),
            )
            .with_detail("indexName", Value::String(index_name.to_string()))
            .with_detail("nodeId", Value::String(node_id.clone())));
        }
        self.engine.drop_index(index_name)?;
        self.forget_orphan(index_name);
        Ok(())
    }
}
