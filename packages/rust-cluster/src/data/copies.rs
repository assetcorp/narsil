use std::collections::HashSet;
use std::sync::Mutex;

use narsil::replication::PartitionCopies;
use narsil::{Map, Narsil, NarsilConfig, Value};

use crate::controller::lock;
use crate::error::{ClusterError, ClusterResult, codes};

pub(super) struct LocalCopies {
    node_id: String,
    engine: Narsil,
    orphaned: Mutex<HashSet<String>>,
    explicit_drop: Mutex<()>,
}

impl LocalCopies {
    pub(super) fn open(node_id: String, config: NarsilConfig) -> ClusterResult<LocalCopies> {
        Ok(LocalCopies {
            node_id,
            engine: Narsil::open(config)?,
            orphaned: Mutex::new(HashSet::new()),
            explicit_drop: Mutex::new(()),
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

    pub(super) fn drop_superseded(&self, index_name: &str) -> ClusterResult<()> {
        Ok(self.engine.drop_index(index_name)?)
    }

    pub(super) fn mark_orphaned(&self, index_name: &str) {
        lock(&self.orphaned).insert(index_name.to_string());
    }

    fn is_orphaned(&self, index_name: &str) -> bool {
        lock(&self.orphaned).contains(index_name)
    }

    fn refuse_orphaned(&self, index_name: &str) -> ClusterResult<()> {
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
        lock(&self.orphaned).remove(index_name);
        Ok(())
    }
}
