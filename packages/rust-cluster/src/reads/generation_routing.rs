use std::future::Future;

use narsil::Value;

use super::ReadDeps;
use crate::allocator::Table;
use crate::constants::HIDDEN_GENERATION_PREFIX;
use crate::error::{ClusterError, ClusterResult, codes};

const CODES_OF_A_LOST_LAYOUT: [&str; 5] = [
    codes::INDEX_NOT_FOUND,
    codes::QUERY_NO_ACTIVE_REPLICA,
    codes::QUERY_NODE_TIMEOUT,
    codes::QUERY_PARTIAL_FAILURE,
    codes::QUERY_ROUTING_FAILED,
];

pub(crate) fn is_hidden_generation(index_name: &str) -> bool {
    index_name.starts_with(HIDDEN_GENERATION_PREFIX)
}

pub(crate) fn refuse_hidden_generation(index_name: &str) -> ClusterResult<()> {
    if !is_hidden_generation(index_name) {
        return Ok(());
    }
    Err(ClusterError::new(
        codes::CONFIG_INVALID,
        format!(
            "Index names that start with '{HIDDEN_GENERATION_PREFIX}' are reserved for partition count changes"
        ),
    )
    .with_detail("indexName", Value::from(index_name)))
}

fn serving_name_of_table(table: Option<Table>, index_name: &str) -> String {
    table
        .and_then(|table| table.generation)
        .unwrap_or_else(|| index_name.to_string())
}

pub(crate) async fn serving_name(deps: &ReadDeps, index_name: &str) -> ClusterResult<String> {
    refuse_hidden_generation(index_name)?;
    Ok(serving_name_of_table(
        deps.view.read(index_name).await?,
        index_name,
    ))
}

async fn live_serving_name(deps: &ReadDeps, index_name: &str) -> ClusterResult<String> {
    refuse_hidden_generation(index_name)?;
    let live = deps
        .coordinator
        .allocation(index_name)
        .await?
        .map(|stored| Table::from_stored(&stored));
    Ok(serving_name_of_table(live, index_name))
}

async fn moved_name_of(deps: &ReadDeps, index_name: &str, serving: &str) -> Option<String> {
    let live = live_serving_name(deps, index_name)
        .await
        .unwrap_or_else(|_| serving.to_string());
    (live != serving).then_some(live)
}

pub(crate) async fn read_following_the_name<T, F, Fut>(
    deps: &ReadDeps,
    index_name: &str,
    read: F,
    answer_is_partial: Option<fn(&T) -> bool>,
) -> ClusterResult<T>
where
    F: Fn(String) -> Fut,
    Fut: Future<Output = ClusterResult<T>>,
{
    let serving = serving_name(deps, index_name).await?;
    let answer = match read(serving.clone()).await {
        Ok(answer) => answer,
        Err(error) => {
            if !CODES_OF_A_LOST_LAYOUT.contains(&error.code()) {
                return Err(error);
            }
            return match moved_name_of(deps, index_name, &serving).await {
                Some(moved) => read(moved).await,
                None => Err(error),
            };
        }
    };
    match answer_is_partial {
        Some(partial) if partial(&answer) => {
            match moved_name_of(deps, index_name, &serving).await {
                Some(moved) => read(moved).await,
                None => Ok(answer),
            }
        }
        _ => Ok(answer),
    }
}
