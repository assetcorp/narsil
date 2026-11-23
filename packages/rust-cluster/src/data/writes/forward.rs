use std::collections::BTreeMap;
use std::sync::Arc;

use narsil::Value;
use tokio::task::JoinSet;

use super::PrimaryWrites;
use super::condition::Resends;
use super::run::Planned;
use super::scope::Outcome;
use crate::allocator::{Assignment, Table};
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::{ERROR_TYPE_SUFFIX, TransportMessage, message_types};
use crate::payload::decodable;
use crate::payload::forward::{
    ForwardKind, ForwardOperation, ForwardRequest, WriteFailure, decode_forward,
    decode_forward_batch, encode_forward_answer, encode_forward_batch_answer,
    encode_forward_refusal,
};

const FNV_OFFSET_BASIS: u32 = 2_166_136_261;
const FNV_PRIME: u32 = 16_777_619;

pub(crate) fn fnv1a(bytes: &[u8]) -> u32 {
    let mut hash = FNV_OFFSET_BASIS;
    for byte in bytes {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

pub(crate) fn fnv1a_uint32s(values: &[u32]) -> u32 {
    let bytes: Vec<u8> = values
        .iter()
        .flat_map(|value| value.to_be_bytes())
        .collect();
    fnv1a(&bytes)
}

pub(crate) fn routed_partition(document_id: &str, partition_count: usize) -> u32 {
    (fnv1a(document_id.as_bytes()) as usize % partition_count) as u32
}

struct Run {
    kind: ForwardKind,
    operations: Vec<Planned>,
}

fn grouped(operations: Vec<ForwardOperation>, partition_count: usize) -> BTreeMap<u32, Vec<Run>> {
    let mut runs: BTreeMap<u32, Vec<Run>> = BTreeMap::new();
    for (position, operation) in operations.into_iter().enumerate() {
        let partition_id = routed_partition(&operation.document_id, partition_count);
        let partition_runs = runs.entry(partition_id).or_default();
        let planned = Planned {
            position,
            operation,
        };
        match partition_runs.last_mut() {
            Some(run) if run.kind == planned.operation.kind => run.operations.push(planned),
            _ => partition_runs.push(Run {
                kind: planned.operation.kind,
                operations: vec![planned],
            }),
        }
    }
    runs
}

fn routable(table: Option<Table>) -> Option<Table> {
    table.filter(|table| !table.assignments.is_empty())
}

fn leads(table: Option<&Table>, document_id: &str, node_id: &str) -> bool {
    table.is_some_and(|table| {
        let partition_id = routed_partition(document_id, table.assignments.len());
        table
            .assignments
            .get(f64::from(partition_id))
            .is_some_and(|assignment| assignment.is_primary(node_id))
    })
}

pub(crate) fn unassigned(index_name: &str, partition_id: u32) -> ClusterError {
    ClusterError::new(
        codes::PARTITION_UNASSIGNED,
        format!("No primary assigned for partition {partition_id} of index '{index_name}'"),
    )
    .with_detail("indexName", Value::from(index_name))
    .with_detail("partitionId", Value::from(partition_id))
}

fn no_table(index_name: &str, what: &str) -> ClusterError {
    ClusterError::new(
        codes::QUERY_ROUTING_FAILED,
        format!("No allocation table is available for {what} to index '{index_name}'"),
    )
    .with_detail("indexName", Value::from(index_name))
}

fn another_index(index_name: &str, node_id: &str, held_uuid: &str) -> ClusterError {
    ClusterError::new(
        codes::PARTITION_NOT_PRIMARY,
        format!(
            "Node '{node_id}' holds another index named '{index_name}', so it leads no partition of the index the sender routes to"
        ),
    )
    .with_detail("indexName", Value::from(index_name))
    .with_detail("localNodeId", Value::from(node_id))
    .with_detail("heldIndexUuid", Value::from(held_uuid))
}

fn not_primary(index_name: &str, partition_id: u32, node_id: &str) -> ClusterError {
    ClusterError::new(
        codes::PARTITION_NOT_PRIMARY,
        format!(
            "Node '{node_id}' is not primary for partition {partition_id} of index '{index_name}'"
        ),
    )
    .with_detail("indexName", Value::from(index_name))
    .with_detail("partitionId", Value::from(partition_id))
}

impl PrimaryWrites {
    async fn routing_table(
        &self,
        request: &ForwardRequest,
        batch: bool,
    ) -> ClusterResult<Option<Table>> {
        let table = routable(self.view.read(&request.index_name).await?);
        let leads_every = request
            .operations
            .iter()
            .all(|operation| leads(table.as_ref(), &operation.document_id, &self.node_id));
        if leads_every {
            return Ok(table);
        }
        match routable(self.view.refresh(&request.index_name).await?) {
            Some(live) => Ok(Some(live)),
            None if !batch && request.operations.len() == 1 => Ok(table),
            None => Ok(None),
        }
    }

    async fn refused_by_local_copy(
        &self,
        request: &ForwardRequest,
    ) -> ClusterResult<Option<ClusterError>> {
        if let Err(orphaned) = self.refuse_orphaned(&request.index_name) {
            return Ok(Some(orphaned));
        }
        let Some(sent) = request.index_uuid.clone() else {
            return Ok(None);
        };
        let name = request.index_name.clone();
        let held = self
            .on_copies(move |copies| copies.local_uuid(&name))
            .await?;
        Ok(held
            .filter(|held| *held != sent)
            .map(|held| another_index(&request.index_name, &self.node_id, &held)))
    }

    fn checked_assignment(
        &self,
        index_name: &str,
        partition_id: u32,
        assignment: Option<&Assignment>,
        batch: bool,
    ) -> ClusterResult<()> {
        let Some(assignment) = assignment.filter(|assignment| assignment.primary.is_some()) else {
            return Err(unassigned(index_name, partition_id));
        };
        if !assignment.is_primary(&self.node_id) {
            let error = not_primary(index_name, partition_id, &self.node_id);
            return Err(match &assignment.primary {
                _ if batch => error.with_detail("nodeId", Value::from(self.node_id.as_str())),
                Some(primary) => error
                    .with_detail("primaryNodeId", Value::from(primary.as_str()))
                    .with_detail("localNodeId", Value::from(self.node_id.as_str())),
                None => error,
            });
        }
        Ok(())
    }

    async fn apply_partition(
        self: Arc<Self>,
        index_name: String,
        partition_id: u32,
        assignment: Option<Assignment>,
        runs: Vec<Run>,
        batch: bool,
    ) -> Vec<(usize, Outcome)> {
        let mut outcomes = Vec::new();
        let mut resends = Resends::new();
        for run in runs {
            let positions: Vec<usize> = run
                .operations
                .iter()
                .map(|planned| planned.position)
                .collect();
            if let Err(error) =
                self.checked_assignment(&index_name, partition_id, assignment.as_ref(), batch)
            {
                outcomes.extend(
                    positions
                        .iter()
                        .map(|position| (*position, Err(WriteFailure::from(error.clone())))),
                );
                continue;
            }
            let writes = Arc::clone(&self);
            let kind = run.kind;
            let resends = &mut resends;
            let applied = self
                .in_leading_queue(
                    &index_name,
                    partition_id,
                    &positions,
                    move |scope, turn| async move {
                        writes
                            .apply_run(scope, turn, kind, run.operations, resends)
                            .await
                    },
                )
                .await;
            outcomes.extend(applied);
        }
        outcomes
    }

    async fn apply_request(
        self: &Arc<Self>,
        request: ForwardRequest,
        batch: bool,
    ) -> ClusterResult<Vec<Outcome>> {
        let count = request.operations.len();
        let what = if batch {
            "forwarded batch"
        } else {
            "forwarded write"
        };
        let Some(table) = self.routing_table(&request, batch).await? else {
            return Err(no_table(&request.index_name, what));
        };
        let mut partitions = JoinSet::new();
        for (partition_id, runs) in grouped(request.operations, table.assignments.len()) {
            let assignment = table.assignments.get(f64::from(partition_id)).cloned();
            let writes = Arc::clone(self);
            partitions.spawn(writes.apply_partition(
                request.index_name.clone(),
                partition_id,
                assignment,
                runs,
                batch,
            ));
        }
        let mut answered: Vec<Option<Outcome>> = (0..count).map(|_| None).collect();
        while let Some(joined) = partitions.join_next().await {
            let Ok(outcomes) = joined else {
                continue;
            };
            for (position, outcome) in outcomes {
                if let Some(slot) = answered.get_mut(position) {
                    *slot = Some(outcome);
                }
            }
        }
        let unanswered = || {
            ClusterError::new(
                codes::QUERY_ROUTING_FAILED,
                format!(
                    "A {what} to index '{}' stopped before it answered",
                    request.index_name
                ),
            )
        };
        Ok(answered
            .into_iter()
            .map(|outcome| outcome.unwrap_or_else(|| Err(WriteFailure::from(unanswered()))))
            .collect())
    }

    pub(crate) async fn apply_client_writes(
        self: &Arc<Self>,
        request: ForwardRequest,
    ) -> Vec<Result<(), WriteFailure>> {
        let count = request.operations.len();
        let refused = match self.refused_by_local_copy(&request).await {
            Ok(None) => match self.apply_request(request, false).await {
                Ok(outcomes) => return outcomes,
                Err(error) => error,
            },
            Ok(Some(error)) | Err(error) => error,
        };
        (0..count)
            .map(|_| Err(WriteFailure::from(refused.clone())))
            .collect()
    }

    fn reply(
        &self,
        request: &TransportMessage,
        message_type: String,
        payload: Vec<u8>,
    ) -> TransportMessage {
        TransportMessage::new(
            message_type,
            self.node_id.as_str(),
            request.request_id.as_str(),
            payload,
        )
    }

    fn refuse(&self, request: &TransportMessage, failure: &WriteFailure) -> TransportMessage {
        let message_type = format!("{}{ERROR_TYPE_SUFFIX}", request.message_type);
        self.reply(request, message_type, encode_forward_refusal(failure))
    }

    pub(crate) async fn answer_forward(
        self: &Arc<Self>,
        message: &TransportMessage,
    ) -> TransportMessage {
        let decoded = decodable(&message.payload, &message.message_type)
            .and_then(|()| decode_forward(&message.payload));
        let request = match decoded {
            Ok(request) => request,
            Err(error) => return self.refuse(message, &WriteFailure::from(error)),
        };
        match self.refused_by_local_copy(&request).await {
            Ok(None) => {}
            Ok(Some(error)) | Err(error) => {
                return self.refuse(message, &WriteFailure::from(error));
            }
        }
        let document_id = request.operations[0].document_id.clone();
        let outcome = match self.apply_request(request, false).await {
            Ok(mut outcomes) => outcomes.pop().unwrap_or(Ok(())),
            Err(error) => Err(WriteFailure::from(error)),
        };
        match outcome {
            Ok(()) => self.reply(
                message,
                message_types::REPLICATION_FORWARD.to_string(),
                encode_forward_answer(&document_id),
            ),
            Err(failure) => self.refuse(message, &failure),
        }
    }

    pub(crate) async fn answer_forward_batch(
        self: &Arc<Self>,
        message: &TransportMessage,
    ) -> TransportMessage {
        let decoded = decodable(&message.payload, &message.message_type)
            .and_then(|()| decode_forward_batch(&message.payload));
        let request = match decoded {
            Ok(request) => request,
            Err(error) => return self.refuse(message, &WriteFailure::from(error)),
        };
        let document_ids: Vec<String> = request
            .operations
            .iter()
            .map(|operation| operation.document_id.clone())
            .collect();
        let outcomes = match self.refused_by_local_copy(&request).await {
            Ok(None) => match self.apply_request(request, true).await {
                Ok(outcomes) => outcomes,
                Err(error) => document_ids
                    .iter()
                    .map(|_| Err(WriteFailure::from(error.clone())))
                    .collect(),
            },
            Ok(Some(error)) => document_ids
                .iter()
                .map(|_| Err(WriteFailure::from(error.clone())))
                .collect(),
            Err(error) => return self.refuse(message, &WriteFailure::from(error)),
        };
        let results: Vec<(String, Outcome)> = document_ids.into_iter().zip(outcomes).collect();
        self.reply(
            message,
            message_types::REPLICATION_FORWARD_BATCH.to_string(),
            encode_forward_batch_answer(&results),
        )
    }
}
