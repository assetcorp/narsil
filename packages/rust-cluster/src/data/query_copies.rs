use narsil::partitions::{PartitionQuery, PartitionStatistics, StatsExpansion};
use narsil::replication::PartitionCopies;
use narsil::{
    DocumentProjection, ListParams, ListResult, Map, PreflightResult, QueryParams, QueryResult,
    SortField, SuggestParams, SuggestResult, Value,
};

use super::copies::LocalCopies;
use crate::error::ClusterResult;

pub(super) struct CountAnswer {
    pub(super) partitions: Vec<Map>,
    pub(super) language: String,
}

fn vector_shares(held: &[(u32, u64)], vector_bytes: u64) -> Vec<(u32, u64)> {
    let Some(lowest) = held.iter().map(|(partition_id, _)| *partition_id).min() else {
        return Vec::new();
    };
    let total = u128::from(vector_bytes);
    let documents: u128 = held.iter().map(|(_, count)| u128::from(*count)).sum();
    let count = held.len() as u128;
    let mut given = 0u128;
    let mut shares: Vec<(u32, u64)> = held
        .iter()
        .map(|(partition_id, document_count)| {
            let share = match documents {
                0 => total / count,
                _ => total * u128::from(*document_count) / documents,
            };
            given += share;
            (*partition_id, share as u64)
        })
        .collect();
    let left_over = (total - given) as u64;
    for (partition_id, share) in &mut shares {
        if *partition_id == lowest {
            *share += left_over;
        }
    }
    shares
}

impl LocalCopies {
    pub(super) fn count_answer(
        &self,
        index_name: &str,
        partition_ids: &[u32],
    ) -> ClusterResult<CountAnswer> {
        self.refuse_orphaned(index_name)?;
        let stats = self.engine.get_stats(index_name)?;
        let partitions = self.engine.get_partition_stats(index_name)?;
        let held_ids = PartitionCopies::new(&self.engine).held_partitions(index_name)?;
        let held: Vec<(u32, u64)> = partitions
            .iter()
            .map(|partition| (partition.partition_id as u32, partition.document_count))
            .filter(|(partition_id, _)| {
                held_ids
                    .as_ref()
                    .is_none_or(|held| held.contains(partition_id))
            })
            .collect();
        let segment_bytes: Option<u64> = partitions
            .iter()
            .map(|partition| partition.saved_bytes)
            .sum();
        let vector_bytes = match (stats.saved_bytes, segment_bytes) {
            (Some(saved), Some(segments)) => Some(saved.saturating_sub(segments)),
            _ => None,
        };
        let shares = vector_bytes.map(|bytes| vector_shares(&held, bytes));
        let mut answered = Vec::new();
        for partition in &partitions {
            let partition_id = partition.partition_id as u32;
            if !partition_ids.contains(&partition_id) {
                continue;
            }
            let mut entry = Map::with_capacity(6);
            entry.insert("partitionId", Value::from(partition_id));
            entry.insert("documentCount", Value::from(partition.document_count));
            entry.insert(
                "estimatedMemoryBytes",
                Value::from(partition.estimated_memory_bytes),
            );
            if let Some(saved) = partition.saved_bytes {
                entry.insert("savedBytes", Value::from(saved));
            }
            let share = shares.as_ref().and_then(|shares| {
                shares
                    .iter()
                    .find(|(held_id, _)| *held_id == partition_id)
                    .map(|(_, share)| *share)
            });
            if let Some(share) = share {
                entry.insert("vectorSavedBytes", Value::from(share));
            }
            if let Some(log) = partition.log_bytes {
                entry.insert("logBytes", Value::from(log));
            }
            answered.push(entry);
        }
        Ok(CountAnswer {
            partitions: answered,
            language: stats.language,
        })
    }

    pub(super) fn query_partitions(
        &self,
        index_name: &str,
        params: &QueryParams,
        confinement: &PartitionQuery,
    ) -> ClusterResult<QueryResult> {
        self.refuse_orphaned(index_name)?;
        Ok(self
            .engine
            .query_partitions(index_name, params, confinement)?)
    }

    pub(super) fn preflight_partitions(
        &self,
        index_name: &str,
        params: &QueryParams,
        confinement: &PartitionQuery,
    ) -> ClusterResult<PreflightResult> {
        self.refuse_orphaned(index_name)?;
        Ok(self
            .engine
            .preflight_partitions(index_name, params, confinement)?)
    }

    pub(super) fn stats_partitions(
        &self,
        index_name: &str,
        confinement: &PartitionQuery,
        terms: &[String],
        expansion: Option<&StatsExpansion>,
        tokens: &[String],
    ) -> ClusterResult<PartitionStatistics> {
        self.refuse_orphaned(index_name)?;
        Ok(self
            .engine
            .query_stats_partitions(index_name, confinement, terms, expansion, tokens)?)
    }

    pub(super) fn suggest_partitions(
        &self,
        index_name: &str,
        params: &SuggestParams,
        partition_ids: &[u32],
    ) -> ClusterResult<SuggestResult> {
        self.refuse_orphaned(index_name)?;
        Ok(self
            .engine
            .suggest_partitions(index_name, params, partition_ids)?)
    }

    pub(super) fn list_partitions(
        &self,
        index_name: &str,
        params: &ListParams,
        sort: &[SortField],
        partition_ids: &[u32],
    ) -> ClusterResult<ListResult> {
        self.refuse_orphaned(index_name)?;
        Ok(self
            .engine
            .list_partitions(index_name, params, sort, partition_ids)?)
    }

    pub(super) fn vector_fields(&self, index_name: &str) -> ClusterResult<Vec<String>> {
        self.refuse_orphaned(index_name)?;
        Ok(self.engine.vector_fields(index_name)?)
    }

    pub(super) fn fetch_documents(
        &self,
        index_name: &str,
        document_ids: &[(String, u32)],
        projection: &DocumentProjection,
    ) -> ClusterResult<Vec<(String, Map)>> {
        self.refuse_orphaned(index_name)?;
        let requested: Vec<String> = document_ids
            .iter()
            .map(|(doc_id, _)| doc_id.clone())
            .collect();
        let found = self
            .engine
            .get_multiple_with(index_name, &requested, Some(projection))?;
        Ok(requested
            .into_iter()
            .filter_map(|doc_id| {
                let document = found.get(&doc_id)?.clone();
                Some((doc_id, document))
            })
            .collect())
    }
}
