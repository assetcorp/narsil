use std::collections::HashMap;
use std::sync::Arc;

use narsil::{IndexInfo, IndexResidencyState};
use tokio::task::JoinSet;

use super::ReadDeps;
use super::counts::{ClusterIndexStats, stats_cluster};
use super::generation_routing::{is_hidden_generation, serving_name};
use crate::error::{ClusterResult, codes};

struct ListedIndex {
    serving_name: String,
    stats: ClusterIndexStats,
}

async fn stats_of_listed_index(
    deps: &Arc<ReadDeps>,
    index_name: &str,
) -> ClusterResult<Option<ListedIndex>> {
    let described = async {
        let serving_name = serving_name(deps, index_name).await?;
        let stats = stats_cluster(deps, &serving_name).await?;
        Ok::<_, crate::error::ClusterError>(ListedIndex {
            serving_name,
            stats,
        })
    }
    .await;
    match described {
        Ok(listed) => Ok(Some(listed)),
        Err(error) if error.code() == codes::INDEX_NOT_FOUND => Ok(None),
        Err(error) => Err(error),
    }
}

pub(crate) async fn list_indexes_cluster(deps: &Arc<ReadDeps>) -> ClusterResult<Vec<IndexInfo>> {
    let held: HashMap<String, IndexInfo> = deps
        .local
        .as_ref()
        .map(|local| {
            local
                .list_indexes()
                .into_iter()
                .map(|index| (index.name.clone(), index))
                .collect()
        })
        .unwrap_or_default();
    let names: Vec<String> = deps
        .coordinator
        .list_schemas()
        .await?
        .into_iter()
        .filter(|name| !is_hidden_generation(name))
        .collect();
    let mut describing = JoinSet::new();
    for (position, name) in names.iter().enumerate() {
        let deps = Arc::clone(deps);
        let name = name.clone();
        describing.spawn(async move { (position, stats_of_listed_index(&deps, &name).await) });
    }
    let mut described: Vec<Option<ListedIndex>> = names.iter().map(|_| None).collect();
    let mut first_error = None;
    while let Some(joined) = describing.join_next().await {
        match joined {
            Ok((position, Ok(entry))) => {
                if let Some(slot) = described.get_mut(position) {
                    *slot = entry;
                }
            }
            Ok((_, Err(error))) => {
                first_error.get_or_insert(error);
            }
            Err(_) => {
                first_error.get_or_insert(crate::error::ClusterError::new(
                    codes::INTERNAL_ERROR,
                    "Reading the stats of an index stopped before it finished",
                ));
            }
        }
    }
    if let Some(error) = first_error {
        return Err(error);
    }
    Ok(names
        .into_iter()
        .zip(described)
        .filter_map(|(name, entry)| {
            let entry = entry?;
            let local = held.get(&entry.serving_name);
            Some(IndexInfo {
                name,
                document_count: entry.stats.document_count,
                partition_count: entry.stats.partition_count,
                language: entry.stats.language,
                analysis_stale: local.is_some_and(|local| local.analysis_stale),
                state: local
                    .map(|local| local.state)
                    .unwrap_or(IndexResidencyState::Open),
                reopen_count: local.map(|local| local.reopen_count).unwrap_or(0),
            })
        })
        .collect())
}
