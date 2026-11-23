use std::sync::Arc;

use super::DataRole;
use crate::backups::{PrimaryContext, answer_backup_partition, answer_restore_partition};
use crate::controller::lock;
use crate::data::queries::{QueryDeps, answer_query};
use crate::error::ClusterResult;
use crate::message::{TransportMessage, message_types, refusal};
use crate::node::not_ready;

impl DataRole {
    pub(super) async fn answer_query_message(
        &self,
        message: &TransportMessage,
    ) -> TransportMessage {
        let deps = match (self.settled_copies(), self.primary_writes()) {
            (Ok(copies), Ok(writes)) => QueryDeps {
                node_id: &self.node_id,
                copies,
                view: writes.view(),
                contexts: Arc::clone(&self.search_contexts),
            },
            (Err(error), _) | (_, Err(error)) => {
                return refusal(message, &self.node_id, &error);
            }
        };
        match answer_query(&deps, message).await {
            Ok(reply) => reply,
            Err(error) => refusal(message, &self.node_id, &error),
        }
    }

    pub(super) async fn answer_rebuild_analysis(
        &self,
        message: &TransportMessage,
    ) -> ClusterResult<TransportMessage> {
        let analysis = lock(&self.analysis)
            .as_ref()
            .map(|(analysis, _)| Arc::clone(analysis))
            .ok_or_else(|| not_ready(&self.node_id))?;
        analysis.answer_rebuild(message).await
    }

    pub(super) async fn answer_backup_message(
        &self,
        message: &TransportMessage,
    ) -> ClusterResult<TransportMessage> {
        let context = PrimaryContext {
            node_id: &self.node_id,
            coordinator: &self.coordinator,
            writes: self.primary_writes()?,
        };
        let primary = self.backups.as_ref();
        match message.message_type.as_str() {
            message_types::CLUSTER_BACKUP_PARTITION => {
                answer_backup_partition(primary, context, message).await
            }
            _ => answer_restore_partition(primary, context, message).await,
        }
    }
}
