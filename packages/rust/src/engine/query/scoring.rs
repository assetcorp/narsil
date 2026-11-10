use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;

use super::params::QueryParams;
use crate::config::ScoringMode;
use crate::engine::index::IndexState;
use crate::error::Result;
use crate::index::partition::PartitionSnapshot;
use crate::search::stats::{QueryStats, partition_frequency};

/// Returns how a query gathers its BM25 statistics: its own `scoring`, else the index's `defaultScoring`, else
/// `Local`.
///
/// This engine holds no invalidation adapter, so it receives no statistics that other instances publish, and a
/// `Broadcast` query scores with the statistics of every partition that the index holds, exactly as `Dfs` does.
pub(crate) fn scoring_mode(index: &IndexState, params: &QueryParams) -> ScoringMode {
    let mode = params
        .scoring
        .or(index.config().default_scoring)
        .unwrap_or(ScoringMode::Local);
    match mode {
        ScoringMode::Broadcast => ScoringMode::Dfs,
        other => other,
    }
}

/// The statistics of every partition of an index summed for one query, so that each partition scores a document as
/// though the index held one partition.
pub(crate) struct GlobalStats {
    stats: QueryStats,
}

impl GlobalStats {
    /// Sums the live documents and field lengths of `snapshots`, and the live documents that hold each of `terms`.
    pub(crate) fn of(
        snapshots: &[Arc<PartitionSnapshot>],
        terms: BTreeSet<String>,
    ) -> Result<GlobalStats> {
        let mut documents = 0u64;
        let mut field_totals: BTreeMap<String, f64> = BTreeMap::new();
        for snapshot in snapshots {
            documents += snapshot.stats.documents;
            for (field, total) in &snapshot.stats.field_totals {
                *field_totals.entry(field.clone()).or_insert(0.0) += total;
            }
        }
        let averages = match documents {
            0 => BTreeMap::new(),
            _ => field_totals
                .into_iter()
                .map(|(field, total)| (field, total / documents as f64))
                .collect(),
        };
        let mut frequencies = HashMap::with_capacity(terms.len());
        for term in terms {
            let mut total = 0u64;
            for snapshot in snapshots {
                total += partition_frequency(snapshot, &term)?;
            }
            if total > 0 {
                frequencies.insert(term, total as f64);
            }
        }
        Ok(GlobalStats {
            stats: QueryStats {
                total_documents: documents as f64,
                averages,
                frequencies,
            },
        })
    }

    /// Returns the statistics that every partition scores the query with, which hold every term that the query
    /// reaches in any partition.
    pub(crate) fn stats(&self) -> &QueryStats {
        &self.stats
    }
}
