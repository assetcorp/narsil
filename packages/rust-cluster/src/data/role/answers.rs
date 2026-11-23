use std::sync::Arc;

use super::DataRole;
use crate::backups::{PrimaryContext, answer_backup_partition, answer_restore_partition};
use crate::controller::lock;
use crate::data::analysis_change::AnalysisChanges;
use crate::error::ClusterResult;
use crate::message::{TransportMessage, message_types, refusal};
use crate::node::not_ready;

impl DataRole {
    pub(super) async fn answer_query_message(
        &self,
        message: &TransportMessage,
    ) -> TransportMessage {
        match self.local_reads() {
            Ok(reads) => reads.answer(message).await,
            Err(error) => refusal(message, &self.node_id, &error),
        }
    }

    pub(super) fn analysis_changes(&self) -> ClusterResult<Arc<AnalysisChanges>> {
        lock(&self.analysis)
            .as_ref()
            .map(|(analysis, _)| Arc::clone(analysis))
            .ok_or_else(|| not_ready(&self.node_id))
    }

    pub(super) async fn answer_rebuild_analysis(
        &self,
        message: &TransportMessage,
    ) -> ClusterResult<TransportMessage> {
        self.analysis_changes()?.answer_rebuild(message).await
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
