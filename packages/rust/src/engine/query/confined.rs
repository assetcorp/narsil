use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use crate::config::Bm25Params;
use crate::engine::index::IndexState;
use crate::index::partition::PartitionSnapshot;
use crate::search::stats::QueryStats;

/// The BM25 statistics of a whole index that a cluster coordinator sums across every data node under DFS scoring,
/// which a partition-scoped query scores against in place of the statistics of the partitions that it reads.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SuppliedStatistics {
    /// The live documents of every partition of the index.
    pub total_documents: f64,
    /// The live documents that hold each query token.
    pub doc_frequencies: HashMap<String, f64>,
    /// The average length of each field across those documents.
    pub average_field_lengths: BTreeMap<String, f64>,
}

/// Confines a query to some partitions of an index, the way a cluster data node answers a search for the
/// partitions that a coordinator routed to it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PartitionQuery {
    /// The partitions to search, by position in the index.
    pub partition_ids: Vec<u32>,
    /// The statistics to score with, where the coordinator collected them across the cluster.
    pub global_stats: Option<SuppliedStatistics>,
    /// The re-score window of a vector search, which a hybrid query with a depth sets on its vector leg.
    pub rescore_window: Option<usize>,
    /// The index's BM25 setting as the coordinator holds it, which replaces the setting stored with this copy.
    pub index_bm25: Option<Bm25Params>,
}

impl PartitionQuery {
    pub(crate) fn query_stats(&self) -> Option<QueryStats> {
        let supplied = self.global_stats.as_ref()?;
        Some(QueryStats {
            total_documents: supplied.total_documents,
            averages: supplied.average_field_lengths.clone(),
            frequencies: supplied.doc_frequencies.clone(),
        })
    }

    pub(crate) fn holds(&self, position: usize) -> bool {
        self.partition_ids
            .iter()
            .any(|&partition_id| partition_id as usize == position)
    }

    pub(crate) fn held_count(&self, partition_count: usize) -> usize {
        let mut held: Vec<u32> = self
            .partition_ids
            .iter()
            .copied()
            .filter(|&partition_id| (partition_id as usize) < partition_count)
            .collect();
        held.sort_unstable();
        held.dedup();
        held.len()
    }

    pub(crate) fn confine(
        &self,
        index: &IndexState,
        partitions: Vec<Arc<PartitionSnapshot>>,
    ) -> Vec<Arc<PartitionSnapshot>> {
        let empty = Arc::new(PartitionSnapshot::new(index.track_positions));
        partitions
            .into_iter()
            .enumerate()
            .map(|(position, snapshot)| {
                if self.holds(position) {
                    snapshot
                } else {
                    Arc::clone(&empty)
                }
            })
            .collect()
    }
}
