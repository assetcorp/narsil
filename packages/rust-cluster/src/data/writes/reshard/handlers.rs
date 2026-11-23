use std::sync::Arc;

use narsil::{Map, Value};

use super::super::PrimaryWrites;
use super::payloads::{encoded_answer, read_cutover, read_forward, read_purge, read_start};
use crate::data::queries::{ServedRead, refuse_unserved_read};
use crate::error::ClusterResult;
use crate::message::{TransportMessage, message_types, refusal};
use crate::payload::forward::encode_forward_batch_answer;

impl PrimaryWrites {
    pub(super) async fn refuse_unserved_partition_read(
        &self,
        index_name: &str,
        partition_id: u32,
    ) -> ClusterResult<()> {
        refuse_unserved_read(
            &self.view,
            &self.node_id,
            index_name,
            &[partition_id],
            ServedRead::PartitionRead,
        )
        .await
    }

    fn reshard_reply(&self, message: &TransportMessage, payload: Vec<u8>) -> TransportMessage {
        TransportMessage::new(
            message.message_type.as_str(),
            self.node_id.as_str(),
            message.request_id.as_str(),
            payload,
        )
    }

    async fn answer_reshard_start(
        self: &Arc<Self>,
        message: &TransportMessage,
    ) -> ClusterResult<TransportMessage> {
        let start = read_start(message)?;
        self.refuse_unserved_partition_read(&start.source_generation, start.partition_id)
            .await?;
        let (job_id, partition_id) = (start.job_id.clone(), start.partition_id);
        let snapshot_seq_no = self.start_reshard_copy(start).await?;
        let mut result = Map::with_capacity(3);
        result.insert("jobId", Value::from(job_id.as_str()));
        result.insert("partitionId", Value::from(partition_id));
        result.insert("snapshotSeqNo", Value::Number(snapshot_seq_no as f64));
        Ok(self.reshard_reply(message, encoded_answer(result)))
    }

    async fn answer_reshard_forward(
        self: &Arc<Self>,
        message: &TransportMessage,
    ) -> ClusterResult<TransportMessage> {
        let results = self.apply_reshard_forward(read_forward(message)?).await?;
        Ok(self.reshard_reply(message, encode_forward_batch_answer(&results)))
    }

    async fn answer_reshard_cutover(
        self: &Arc<Self>,
        message: &TransportMessage,
    ) -> ClusterResult<TransportMessage> {
        let cutover = read_cutover(message)?;
        let last_seq_no = self.apply_reshard_cutover(&cutover).await?;
        let mut result = Map::with_capacity(3);
        result.insert("jobId", Value::from(cutover.job_id.as_str()));
        result.insert("partitionId", Value::from(cutover.partition_id));
        result.insert("lastSeqNo", Value::Number(last_seq_no as f64));
        Ok(self.reshard_reply(message, encoded_answer(result)))
    }

    async fn answer_reshard_purge(
        self: &Arc<Self>,
        message: &TransportMessage,
    ) -> ClusterResult<TransportMessage> {
        let removed = self.purge_reshard_source(read_purge(message)?).await?;
        let mut result = Map::with_capacity(1);
        result.insert("removed", Value::Number(removed as f64));
        Ok(self.reshard_reply(message, encoded_answer(result)))
    }

    pub(crate) async fn answer_reshard(
        self: &Arc<Self>,
        message: &TransportMessage,
    ) -> TransportMessage {
        let answered = match message.message_type.as_str() {
            message_types::CLUSTER_RESHARD_START => self.answer_reshard_start(message).await,
            message_types::CLUSTER_RESHARD_FORWARD => self.answer_reshard_forward(message).await,
            message_types::CLUSTER_RESHARD_CUTOVER => self.answer_reshard_cutover(message).await,
            _ => self.answer_reshard_purge(message).await,
        };
        answered.unwrap_or_else(|error| refusal(message, &self.node_id, &error))
    }
}
