use narsil::replication::PartitionCopies;
use narsil::{Map, Value};

use super::LocalCopies;
use crate::controller::lock;
use crate::error::{ClusterError, ClusterResult, codes};

impl LocalCopies {
    pub(in crate::data) fn mark_orphaned(&self, index_name: &str, unreadable: bool) {
        lock(&self.orphaned).insert(index_name.to_string());
        let mut unreadable_names = lock(&self.unreadable);
        if unreadable {
            unreadable_names.insert(index_name.to_string());
        } else {
            unreadable_names.remove(index_name);
        }
    }

    pub(in crate::data) fn forget_orphan(&self, index_name: &str) {
        lock(&self.orphaned).remove(index_name);
        lock(&self.unreadable).remove(index_name);
    }

    pub(in crate::data) fn unreadable_names(&self) -> Vec<String> {
        let mut names: Vec<String> = lock(&self.unreadable).iter().cloned().collect();
        names.sort();
        names
    }

    pub(in crate::data) fn is_orphaned(&self, index_name: &str) -> bool {
        lock(&self.orphaned).contains(index_name)
    }

    pub(in crate::data) fn refuse_orphaned(&self, index_name: &str) -> ClusterResult<()> {
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

    pub(in crate::data) fn document(
        &self,
        index_name: &str,
        document_id: &str,
    ) -> ClusterResult<Option<Map>> {
        self.refuse_orphaned(index_name)?;
        Ok(PartitionCopies::new(&self.engine).document(index_name, document_id)?)
    }

    pub(in crate::data) fn drop_orphaned(&self, index_name: &str) -> ClusterResult<()> {
        let _turn = lock(&self.index_lifecycle);
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
