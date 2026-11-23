use std::time::Duration;

use narsil::{
    Map, QuerySuggestionsBuild, QuerySuggestionsBuildStatus, QuerySuggestionsBuildTrigger, Value,
};

use super::super::handle::ClusterNode;
use super::super::rebalance::resolve_node_targets;
use super::build_records::read_cluster_build_record;
use crate::constants::{BUILD_RECORD_POLL_INTERVAL_MS, CONTROLLER_LEASE_KEY};
use crate::controller::now_ms;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::message_types;
use crate::rebalance::{RebalanceExchange, exchange_rebalance_message};

fn no_controller(index_name: &str) -> ClusterError {
    ClusterError::new(
        codes::NODE_NOT_CONTROLLER,
        format!(
            "No node holds the controller lease, so the build of the suggestions of index '{index_name}' cannot start"
        ),
    )
    .with_detail("indexName", Value::from(index_name))
}

fn skipped_build(build_id: String) -> QuerySuggestionsBuild {
    let now = now_ms() as u64;
    QuerySuggestionsBuild {
        build_id,
        trigger: QuerySuggestionsBuildTrigger::Caller,
        status: QuerySuggestionsBuildStatus::Skipped,
        started_at: now,
        ended_at: Some(now),
        published: 0,
        removed: 0,
        discarded: 0,
        error_code: None,
    }
}

fn lost_build(index_name: &str, build_id: &str, reason: &str) -> ClusterError {
    ClusterError::new(
        codes::ALLOCATION_FAILED,
        format!(
            "The outcome of build '{build_id}' of the suggestions of index '{index_name}' is unknown, because {reason}"
        ),
    )
    .with_detail("indexName", Value::from(index_name))
    .with_detail("buildId", Value::from(build_id))
}

impl ClusterNode {
    async fn await_build(
        &self,
        index_name: &str,
        build_id: &str,
        controller_node_id: &str,
    ) -> ClusterResult<QuerySuggestionsBuild> {
        let coordinator = self.inner.coordinator();
        loop {
            self.guard_shutdown()?;
            let record = read_cluster_build_record(coordinator, index_name).await?;
            let Some(record) = record.filter(|record| record.build().build_id == build_id) else {
                return Err(lost_build(
                    index_name,
                    build_id,
                    "another build or a drop replaced its record",
                ));
            };
            if record.build().status != QuerySuggestionsBuildStatus::Running {
                return Ok(record.build().clone());
            }
            let holder = coordinator.lease_holder(CONTROLLER_LEASE_KEY).await?;
            if holder.as_deref() != Some(controller_node_id) {
                return Err(lost_build(
                    index_name,
                    build_id,
                    &format!(
                        "node '{controller_node_id}' gave up the controller lease while it ran"
                    ),
                ));
            }
            tokio::time::sleep(Duration::from_millis(BUILD_RECORD_POLL_INTERVAL_MS)).await;
        }
    }

    pub(super) async fn request_cluster_build(
        &self,
        index_name: &str,
    ) -> ClusterResult<QuerySuggestionsBuild> {
        self.guard_shutdown()?;
        let coordinator = self.inner.coordinator();
        let Some(controller_node_id) = coordinator.lease_holder(CONTROLLER_LEASE_KEY).await? else {
            return Err(no_controller(index_name));
        };
        let failure_message = format!(
            "The controller '{controller_node_id}' did not answer the build of the suggestions of index '{index_name}'"
        );
        let mut payload = Map::with_capacity(2);
        payload.insert("indexName", Value::from(index_name));
        payload.insert("trigger", Value::from("caller"));
        let mut details = Map::with_capacity(2);
        details.insert("indexName", Value::from(index_name));
        details.insert("controllerNodeId", Value::from(controller_node_id.as_str()));
        let reply = exchange_rebalance_message(RebalanceExchange {
            transport: self.inner.transport(),
            sender_id: self.node_id(),
            targets: resolve_node_targets(coordinator, &controller_node_id).await?,
            message_type: message_types::SUGGESTIONS_BUILD,
            payload: Value::Object(payload),
            failure_message: failure_message.clone(),
            details,
        })
        .await?;
        let status = reply.get("status").and_then(Value::as_str);
        let (Some(Value::String(build_id)), Some(status @ ("running" | "skipped"))) =
            (reply.get("buildId"), status)
        else {
            return Err(ClusterError::new(
                codes::ALLOCATION_FAILED,
                format!("{failure_message}: the answer was unreadable"),
            )
            .with_detail("indexName", Value::from(index_name))
            .with_detail("controllerNodeId", Value::from(controller_node_id.as_str())));
        };
        if status == "skipped" {
            return Ok(skipped_build(build_id.clone()));
        }
        self.await_build(index_name, build_id, &controller_node_id)
            .await
    }
}
