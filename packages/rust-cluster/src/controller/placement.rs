use std::collections::HashSet;

use super::metadata::{rebalance_generations, records_previous_documents};
use crate::constants::{CHANGE_CAPTURE_SPEC_VERSION, HIDDEN_GENERATION_PREFIX};
use crate::coordinator::NodeRegistration;
use crate::coordinator::etcd::EtcdCoordinator;
use crate::error::ClusterResult;
use crate::version::reaches_version;

pub(crate) struct NodesFor {
    all: Vec<NodeRegistration>,
    capable: Vec<NodeRegistration>,
    recording: HashSet<String>,
}

impl NodesFor {
    pub(crate) fn for_index(&self, index_name: &str) -> &[NodeRegistration] {
        if self.recording.contains(index_name) {
            &self.capable
        } else {
            &self.all
        }
    }

    pub(crate) fn every_node(&self) -> &[NodeRegistration] {
        &self.all
    }
}

pub(crate) async fn nodes_for_each_index(
    coordinator: &EtcdCoordinator,
    nodes: Vec<NodeRegistration>,
    index_names: &[String],
) -> ClusterResult<NodesFor> {
    let capable: Vec<NodeRegistration> = nodes
        .iter()
        .filter(|node| reaches_version(&node.version, CHANGE_CAPTURE_SPEC_VERSION))
        .cloned()
        .collect();
    let mut recording = HashSet::new();
    if capable.len() == nodes.len() {
        return Ok(NodesFor {
            all: nodes,
            capable: Vec::new(),
            recording,
        });
    }
    for index_name in index_names {
        if index_name.starts_with(HIDDEN_GENERATION_PREFIX)
            || !records_previous_documents(coordinator, index_name).await
        {
            continue;
        }
        recording.insert(index_name.clone());
        if let Some(generation) = coordinator
            .allocation(index_name)
            .await?
            .and_then(|table| table.generation)
        {
            recording.insert(generation);
        }
        if let Some((source, target)) = rebalance_generations(coordinator, index_name).await? {
            recording.insert(source);
            recording.insert(target);
        }
    }
    Ok(NodesFor {
        all: nodes,
        capable,
        recording,
    })
}
