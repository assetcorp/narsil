use std::sync::Arc;

use narsil::Value;

use super::PrimaryWrites;
use super::partition::{Partition, Terms};
use crate::allocator::{Assignment, Table};
use crate::controller::lock;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::{TransportMessage, message_types, refusal};
use crate::payload::decodable;
use crate::payload::replica::{
    EntryRun, decode_entry_batch_payload, decode_entry_payload, decode_term_start, encode_ack,
    encode_term_start_ack,
};
use crate::payload::term_start::HeldEnd;

struct Sender<'a> {
    index_name: &'a str,
    partition_id: u32,
    primary_term: u64,
    node_id: &'a str,
}

fn invalid(sender: &Sender<'_>, message: String) -> ClusterError {
    ClusterError::new(codes::REPLICATION_ENTRY_INVALID, message)
        .with_detail("indexName", Value::from(sender.index_name))
        .with_detail("partitionId", Value::from(sender.partition_id))
}

fn term_refusing_sender(terms: &Terms, sender_term: u64) -> Option<u64> {
    if terms.started > 0 && sender_term <= terms.started {
        return Some(terms.started);
    }
    (sender_term < terms.accepted).then_some(terms.accepted)
}

fn sender_refusal(
    table: Option<&Table>,
    sender: &Sender<'_>,
    local_node_id: &str,
    terms: &Terms,
) -> Result<Assignment, ClusterError> {
    let (index_name, partition_id) = (sender.index_name, sender.partition_id);
    let Some(table) = table else {
        return Err(invalid(
            sender,
            format!(
                "No allocation table is available for replication entry on index '{index_name}'"
            ),
        ));
    };
    let Some(assignment) = table.assignments.get(f64::from(partition_id)) else {
        return Err(invalid(
            sender,
            format!(
                "No assignment exists for replication entry partition {partition_id} of index '{index_name}'"
            ),
        ));
    };
    if !assignment.is_primary(sender.node_id) {
        let primary = assignment
            .primary
            .as_deref()
            .map_or(Value::Null, Value::from);
        return Err(invalid(
            sender,
            format!(
                "Replication entry for index '{index_name}' partition {partition_id} came from a non-primary node"
            ),
        )
        .with_detail("sourceNodeId", Value::from(sender.node_id))
        .with_detail("primaryNodeId", primary));
    }
    let assigned_term = assignment.primary_term as u64;
    if let Some(known_term) = term_refusing_sender(terms, assigned_term) {
        return Err(ClusterError::new(
            codes::REPLICATION_TERM_MISMATCH,
            format!(
                "Replication entry for index '{index_name}' partition {partition_id} came from a primary at term {assigned_term}, below the term {known_term} this node already knows"
            ),
        )
        .with_detail("indexName", Value::from(index_name))
        .with_detail("partitionId", Value::from(partition_id))
        .with_detail("sourceNodeId", Value::from(sender.node_id))
        .with_detail("primaryTerm", Value::from(assigned_term))
        .with_detail("knownTerm", Value::from(known_term)));
    }
    if sender.primary_term > assigned_term {
        return Err(ClusterError::new(
            codes::REPLICATION_TERM_MISMATCH,
            format!(
                "Replication entry term {} is newer than allocation term {assigned_term}",
                sender.primary_term
            ),
        )
        .with_detail("indexName", Value::from(index_name))
        .with_detail("partitionId", Value::from(partition_id)));
    }
    if !assignment.holds_replica(local_node_id) {
        return Err(invalid(
            sender,
            format!(
                "Node '{local_node_id}' is not an assigned replica for index '{index_name}' partition {partition_id}"
            ),
        )
        .with_detail("nodeId", Value::from(local_node_id)));
    }
    Ok(assignment.clone())
}

impl PrimaryWrites {
    async fn sender_assignment(
        &self,
        partition: &Partition,
        sender: &Sender<'_>,
    ) -> ClusterResult<Assignment> {
        let refusal = |table: Option<Table>| {
            let terms = lock(&partition.terms);
            sender_refusal(table.as_ref(), sender, &self.node_id, &terms)
        };
        if let Ok(assignment) = refusal(self.view.read(sender.index_name).await?) {
            return Ok(assignment);
        }
        refusal(self.view.refresh(sender.index_name).await?)
    }

    async fn refuse_another_index(
        &self,
        index_name: &str,
        requested: Option<&str>,
    ) -> ClusterResult<()> {
        let Some(requested) = requested else {
            return Ok(());
        };
        let name = index_name.to_string();
        let local = self
            .on_copies(move |copies| copies.local_uuid(&name))
            .await?;
        if local.is_none_or(|local| local == requested) {
            return Ok(());
        }
        Err(ClusterError::new(
            codes::INDEX_NOT_FOUND,
            format!(
                "Node '{}' holds no copy of the index '{index_name}' that the primary replicates, only an earlier index of that name",
                self.node_id
            ),
        )
        .with_detail("indexName", Value::from(index_name))
        .with_detail("localNodeId", Value::from(self.node_id.as_str())))
    }

    async fn take_entries(self: &Arc<Self>, run: EntryRun, source: &str) -> ClusterResult<Vec<u8>> {
        let (Some(first), Some(last)) = (run.entries.first(), run.entries.last()) else {
            return Err(ClusterError::new(
                codes::REPLICATION_ENTRY_INVALID,
                "Invalid EntryBatchPayload: \"entries\" must not be empty",
            ));
        };
        let (index_name, partition_id) = (last.index_name.clone(), last.partition_id);
        let ack = encode_ack(&index_name, partition_id, last.entry.seq_no);
        self.refuse_another_index(&index_name, run.index_uuid.as_deref())
            .await?;
        let sender = Sender {
            index_name: &first.index_name,
            partition_id: first.partition_id,
            primary_term: first.entry.primary_term,
            node_id: source,
        };
        let partition = self.partitions.of(&first.index_name, first.partition_id);
        let assignment = self.sender_assignment(&partition, &sender).await?;
        partition.note_superseding(source, assignment.primary_term as u64);
        let _turn = partition.turn().await;
        let current = self.sender_assignment(&partition, &sender).await?;
        partition.note_accepted(current.primary_term as u64);
        self.apply_in_log_order(&partition, run).await?;
        Ok(ack)
    }

    async fn start_term(self: &Arc<Self>, payload: &[u8], source: &str) -> ClusterResult<Vec<u8>> {
        let request = decode_term_start(payload)?;
        self.refuse_another_index(&request.index_name, request.index_uuid.as_deref())
            .await?;
        let sender = Sender {
            index_name: &request.index_name,
            partition_id: request.partition_id,
            primary_term: request.primary_term,
            node_id: source,
        };
        let partition = self
            .partitions
            .of(&request.index_name, request.partition_id);
        self.sender_assignment(&partition, &sender).await?;
        partition.note_superseding(source, request.primary_term);
        let _turn = partition.turn().await;
        partition.note_accepted(request.primary_term);
        let (name, partition_id) = (request.index_name.clone(), request.partition_id);
        let position = self
            .on_copies(move |copies| copies.position(&name, partition_id))
            .await?;
        let held = HeldEnd {
            last_seq_no: position.seq_no,
            last_primary_term: if position.seq_no == 0 {
                0
            } else {
                position.primary_term
            },
        };
        Ok(encode_term_start_ack(
            &request.index_name,
            request.partition_id,
            held,
        ))
    }

    fn answered(
        &self,
        request: &TransportMessage,
        message_type: &str,
        answer: ClusterResult<Vec<u8>>,
    ) -> TransportMessage {
        match answer {
            Ok(payload) => TransportMessage::new(
                message_type,
                self.node_id.as_str(),
                request.request_id.as_str(),
                payload,
            ),
            Err(error) => refusal(request, &self.node_id, &error),
        }
    }

    pub(crate) async fn answer_entries(
        self: &Arc<Self>,
        message: &TransportMessage,
    ) -> TransportMessage {
        let decoded = decodable(&message.payload, &message.message_type).and_then(|()| {
            if message.message_type == message_types::REPLICATION_ENTRY {
                decode_entry_payload(&message.payload)
            } else {
                decode_entry_batch_payload(&message.payload)
            }
        });
        let answer = match decoded {
            Ok(run) => self.take_entries(run, &message.source_id).await,
            Err(error) => Err(error),
        };
        self.answered(message, message_types::REPLICATION_ACK, answer)
    }

    pub(crate) async fn answer_term_start(
        self: &Arc<Self>,
        message: &TransportMessage,
    ) -> TransportMessage {
        let answer = match decodable(&message.payload, &message.message_type) {
            Ok(()) => self.start_term(&message.payload, &message.source_id).await,
            Err(error) => Err(error),
        };
        self.answered(message, message_types::REPLICATION_TERM_START_ACK, answer)
    }
}
