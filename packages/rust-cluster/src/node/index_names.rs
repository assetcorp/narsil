use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use narsil::Value;
use tokio::sync::Notify;

use super::handle::ClusterNode;
use crate::constants::{
    QUERY_SUGGESTIONS_BUILD_RECORD_KEY_PREFIX, QUERY_SUGGESTIONS_BUILD_RECORD_KEY_SUFFIX,
};
use crate::controller::read_index_metadata_snapshot;
use crate::coordinator::AllocationTable;
use crate::error::ClusterResult;
use crate::rebalance::is_hidden_generation;

const ACTIVE_STATE: &str = "ACTIVE";
const CONTROLLER_ROLE: &str = "controller";
const DATA_ROLE: &str = "data";

fn build_record_key(index_name: &str) -> String {
    format!(
        "{QUERY_SUGGESTIONS_BUILD_RECORD_KEY_PREFIX}{index_name}{QUERY_SUGGESTIONS_BUILD_RECORD_KEY_SUFFIX}"
    )
}

fn every_partition_active(table: Option<&AllocationTable>, partition_count: u32) -> bool {
    let Some(table) = table else {
        return false;
    };
    table.assignments.len() >= partition_count as usize
        && table.assignments.iter().all(|(_, assignment)| {
            assignment.get("state").and_then(Value::as_str) == Some(ACTIVE_STATE)
        })
}

impl ClusterNode {
    async fn suggestion_source_of(&self, index_name: &str) -> ClusterResult<Option<String>> {
        let Some(snapshot) =
            read_index_metadata_snapshot(self.inner.coordinator(), index_name).await?
        else {
            return Ok(None);
        };
        let source = snapshot
            .settings
            .as_ref()
            .and_then(|settings| match settings.get("querySuggestionsSource") {
                Some(Value::Object(source)) => source.get("index").and_then(Value::as_str),
                _ => None,
            })
            .map(str::to_string);
        Ok(source)
    }

    pub(super) fn drop_marked_indexes<'a>(
        &'a self,
        index_name: &'a str,
    ) -> Pin<Box<dyn Future<Output = ClusterResult<()>> + Send + 'a>> {
        Box::pin(async move {
            for name in self.inner.coordinator().list_schemas().await? {
                if name == index_name || is_hidden_generation(&name) {
                    continue;
                }
                if self.suggestion_source_of(&name).await?.as_deref() == Some(index_name) {
                    self.drop_index(&name).await?;
                }
            }
            Ok(())
        })
    }

    pub(super) async fn forget_suggestions_of(&self, index_name: &str) -> ClusterResult<()> {
        self.inner
            .coordinator()
            .delete(&build_record_key(index_name))
            .await
    }

    pub(super) async fn clear_leftovers_of_name(&self, index_name: &str) -> ClusterResult<()> {
        let coordinator = self.inner.coordinator();
        let described = read_index_metadata_snapshot(coordinator, index_name)
            .await?
            .is_some()
            && coordinator.schema(index_name).await?.is_some();
        if described {
            return Ok(());
        }
        self.drop_marked_indexes(index_name).await?;
        self.forget_suggestions_of(index_name).await
    }

    async fn allocation_possible(&self) -> ClusterResult<bool> {
        let nodes = self.inner.coordinator().list_nodes().await?;
        let holds = |role: &str| {
            nodes
                .iter()
                .any(|node| node.roles.iter().any(|held| held == role))
        };
        Ok(holds(CONTROLLER_ROLE) && holds(DATA_ROLE))
    }

    async fn serving_allocation_reached(
        &self,
        index_name: &str,
        partition_count: u32,
        reached: &Notify,
    ) -> ClusterResult<()> {
        let current = self.inner.coordinator().allocation(index_name).await?;
        if every_partition_active(current.as_ref(), partition_count)
            || !self.allocation_possible().await?
        {
            return Ok(());
        }
        reached.notified().await;
        Ok(())
    }

    pub(super) async fn wait_for_serving_allocation(
        &self,
        index_name: &str,
        partition_count: u32,
        timeout_ms: u64,
    ) {
        if timeout_ms == 0 {
            return;
        }
        let reached = std::sync::Arc::new(Notify::new());
        let signal = std::sync::Arc::clone(&reached);
        let watched_name = index_name.to_string();
        let watch = self
            .inner
            .coordinator()
            .watch_allocation(move |table| {
                if table.index_name == watched_name
                    && every_partition_active(Some(&table), partition_count)
                {
                    signal.notify_one();
                }
            })
            .await;
        let Ok(watch) = watch else {
            return;
        };
        let wait = self.serving_allocation_reached(index_name, partition_count, &reached);
        let _ = tokio::time::timeout(Duration::from_millis(timeout_ms), wait).await;
        watch.stop();
    }
}
