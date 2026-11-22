use std::sync::Arc;

use narsil::Value;
use narsil::replication::{CopyPosition, HeldTerm};

use crate::allocator::{ACTIVE, Assignment, INITIALISING, MIGRATING, Table};
use crate::controller::lock;
use crate::data::writes::PrimaryWrites;
use crate::data::writes::partition::Partition;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::{TransportMessage, message_types, refusal};
use crate::payload::entry::WireEntry;
use crate::payload::sync::{SyncRequest, decode_sync_request, encode_sync_entries};
use crate::transport::Respond;

enum Tier {
    Incremental { from: u64, log_end: u64 },
    Snapshot,
}

fn refused(code: &str, request: &SyncRequest, message: String) -> ClusterError {
    ClusterError::new(code, message)
        .with_detail("indexName", Value::from(request.index_name.as_str()))
        .with_detail("partitionId", Value::from(request.partition_id))
}

fn bootstrappable(assignment: &Assignment) -> bool {
    [ACTIVE, INITIALISING, MIGRATING].contains(&assignment.state.as_str())
}

fn authorized(table: Option<&Table>, request: &SyncRequest, source: &str) -> ClusterResult<()> {
    let index_name = request.index_name.as_str();
    let denied = |code: &str, reason: String| {
        Err(refused(code, request, reason).with_detail("sourceNodeId", Value::from(source)))
    };
    let Some(table) = table else {
        return denied(
            codes::SNAPSHOT_SYNC_UNAUTHORIZED,
            format!("index '{index_name}' has no allocation"),
        );
    };
    let mut listed = false;
    for (_, assignment) in table.assignments.iter() {
        if !assignment.is_primary(source) && !assignment.holds_replica(source) {
            continue;
        }
        listed = true;
        if bootstrappable(assignment) {
            return Ok(());
        }
    }
    if listed {
        return denied(
            codes::SNAPSHOT_SYNC_NOT_ASSIGNED,
            format!(
                "node '{source}' is listed for index '{index_name}' but not in a bootstrappable state"
            ),
        );
    }
    denied(
        codes::SNAPSHOT_SYNC_UNAUTHORIZED,
        format!("node '{source}' is not an assigned replica for index '{index_name}'"),
    )
}

fn served_assignment(
    table: Option<&Table>,
    request: &SyncRequest,
    source: &str,
    local_node_id: &str,
) -> ClusterResult<Assignment> {
    let (index_name, partition_id) = (request.index_name.as_str(), request.partition_id);
    let Some(assignment) = table.and_then(|table| table.assignments.get(f64::from(partition_id)))
    else {
        return Err(refused(
            codes::SNAPSHOT_SYNC_NOT_ASSIGNED,
            request,
            format!(
                "No assignment exists for sync request partition {partition_id} of index '{index_name}'"
            ),
        ));
    };
    if !assignment.is_primary(local_node_id) {
        let primary = assignment
            .primary
            .as_deref()
            .map_or(Value::Null, Value::from);
        return Err(refused(
            codes::SNAPSHOT_SYNC_UNAUTHORIZED,
            request,
            format!(
                "Node '{local_node_id}' is not primary for sync request partition {partition_id} of index '{index_name}'"
            ),
        )
        .with_detail("localNodeId", Value::from(local_node_id))
        .with_detail("primaryNodeId", primary));
    }
    if !assignment.is_primary(source) && !assignment.holds_replica(source) {
        return Err(refused(
            codes::SNAPSHOT_SYNC_UNAUTHORIZED,
            request,
            format!(
                "Node '{source}' is not assigned to partition {partition_id} of index '{index_name}'"
            ),
        )
        .with_detail("sourceNodeId", Value::from(source)));
    }
    let primary_term = assignment.primary_term as u64;
    if request.last_primary_term > primary_term {
        return Err(refused(
            codes::SNAPSHOT_SYNC_REQUEST_INVALID,
            request,
            format!(
                "Replica term {} is newer than primary term {primary_term}",
                request.last_primary_term
            ),
        )
        .with_detail("lastPrimaryTerm", Value::from(request.last_primary_term))
        .with_detail("primaryTerm", Value::from(primary_term)));
    }
    Ok(assignment.clone())
}

fn tier_from_log(
    partition: &Partition,
    request: &SyncRequest,
    position: CopyPosition,
    held: Option<u64>,
) -> Tier {
    let log = lock(&partition.log);
    let log_end = log.newest_seq_no().unwrap_or(position.seq_no);
    let retains_from = |from: u64| {
        from > log_end
            || log
                .oldest_seq_no()
                .is_some_and(|oldest| oldest <= from && from <= log_end)
    };
    let last_seq_no = request.last_seq_no;
    let from = if last_seq_no == 0 {
        let discarded_none = match log.oldest_seq_no() {
            Some(oldest) => oldest == 1,
            None => position.seq_no == 0,
        };
        discarded_none.then_some(1)
    } else {
        let term = log.term_at(last_seq_no).or(held);
        (last_seq_no <= log_end && term == Some(request.last_primary_term))
            .then_some(last_seq_no + 1)
    };
    match from.filter(|from| retains_from(*from)) {
        Some(from) => Tier::Incremental { from, log_end },
        None => Tier::Snapshot,
    }
}

impl PrimaryWrites {
    async fn refuse_missing_copy(&self, request: &SyncRequest) -> ClusterResult<()> {
        let name = request.index_name.clone();
        let (held, local_uuid) = self
            .on_copies(move |copies| Ok((copies.holds_index(&name), copies.local_uuid(&name)?)))
            .await?;
        let (index_name, partition_id) = (request.index_name.as_str(), request.partition_id);
        let message = if !held {
            format!(
                "Node '{}' holds no copy of index '{index_name}' yet, so it cannot serve a sync for partition {partition_id}",
                self.node_id
            )
        } else if let (Some(local), Some(requested)) = (&local_uuid, &request.index_uuid)
            && local != requested
        {
            format!(
                "Node '{}' holds a copy of an earlier index named '{index_name}', so it cannot serve a sync for partition {partition_id}",
                self.node_id
            )
        } else {
            return Ok(());
        };
        Err(
            refused(codes::SNAPSHOT_SYNC_INDEX_NOT_FOUND, request, message)
                .with_detail("primaryNodeId", Value::from(self.node_id.as_str())),
        )
    }

    async fn choose_tier(
        &self,
        partition: &Partition,
        request: &SyncRequest,
    ) -> ClusterResult<Tier> {
        let (name, partition_id, last_seq_no) = (
            request.index_name.clone(),
            request.partition_id,
            request.last_seq_no,
        );
        let (position, held) = self
            .on_copies(move |copies| {
                let position = copies.position(&name, partition_id)?;
                let held = if last_seq_no == 0 || last_seq_no > position.seq_no {
                    None
                } else if last_seq_no == position.seq_no {
                    Some(position.primary_term)
                } else {
                    match copies.held_term(&name, partition_id, last_seq_no)? {
                        HeldTerm::Held(term) => Some(term),
                        HeldTerm::Absent | HeldTerm::Uncovered => None,
                    }
                };
                Ok((position, held))
            })
            .await?;
        Ok(tier_from_log(partition, request, position, held))
    }

    fn current_session(
        &self,
        partition: &Partition,
        request: &SyncRequest,
        source: &str,
        assignment: &Assignment,
    ) -> ClusterResult<String> {
        let primary_term = assignment.primary_term as u64;
        let mut catch_up = lock(&partition.catch_up);
        let Some(sync_session) = &request.sync_session else {
            return catch_up.open_session(source, primary_term, &assignment.replicas);
        };
        if catch_up.is_current_session(source, sync_session, primary_term) {
            return Ok(sync_session.clone());
        }
        Err(refused(
            codes::REPLICATION_SYNC_FAILED,
            request,
            format!(
                "Node '{source}' reported a sync of partition {} of index '{}' that is no longer its current sync, so it must open a new one",
                request.partition_id, request.index_name
            ),
        )
        .with_detail("sourceNodeId", Value::from(source)))
    }

    async fn send_sync_entries(
        &self,
        message: &TransportMessage,
        respond: &Respond,
        partition: &Partition,
        request: &SyncRequest,
        (from, log_end): (u64, u64),
        sync_session: &str,
    ) -> ClusterResult<()> {
        let index_name = request.index_name.as_str();
        let mut next = from;
        loop {
            let planned_bytes = if next > log_end {
                0
            } else {
                lock(&partition.log).batch_bytes(index_name, next, log_end)
            };
            let Some(_reserved) = self.reserve_when_free(planned_bytes).await else {
                return Ok(());
            };
            let batch = if next > log_end {
                Vec::new()
            } else {
                lock(&partition.log).batch_within(index_name, next, log_end, planned_bytes)
            };
            let first = batch.first().map(|entry| entry.seq_no);
            if next <= log_end && first != Some(next) {
                return Err(refused(
                    codes::REPLICATION_SYNC_FAILED,
                    request,
                    format!(
                        "Node '{}' discarded entry {next} of partition {} of index '{index_name}' before it could send it, so the replica must open a new sync",
                        self.node_id, request.partition_id
                    ),
                ));
            }
            next = batch.last().map_or(next, |last| last.seq_no + 1);
            let wire: Vec<WireEntry> = batch
                .into_iter()
                .map(|entry| WireEntry::of(index_name, request.partition_id, entry))
                .collect();
            let is_last = next > log_end;
            let payload = encode_sync_entries(&wire, is_last, sync_session);
            drop(wire);
            respond
                .send(TransportMessage::new(
                    message_types::REPLICATION_SYNC_ENTRIES,
                    self.node_id.as_str(),
                    message.request_id.as_str(),
                    payload,
                ))
                .await;
            if is_last {
                return Ok(());
            }
        }
    }

    async fn serve_sync(&self, message: &TransportMessage, respond: &Respond) -> ClusterResult<()> {
        let request = decode_sync_request(&message.payload)?;
        let source = message.source_id.as_str();
        let table = self
            .view
            .read_live(&request.index_name)
            .await
            .map_err(|error| {
                refused(
                    codes::SNAPSHOT_SYNC_ALLOCATION_UNAVAILABLE,
                    &request,
                    format!("allocation lookup failed: {}", error.message()),
                )
                .with_detail("sourceNodeId", Value::from(source))
            })?;
        authorized(table.as_ref(), &request, source)?;
        let assignment = served_assignment(table.as_ref(), &request, source, &self.node_id)?;
        self.refuse_missing_copy(&request).await?;
        let partition = self
            .partitions
            .of(&request.index_name, request.partition_id);
        let tier = self.choose_tier(&partition, &request).await?;
        let sync_session = self.current_session(&partition, &request, source, &assignment)?;
        let from_replica = source != self.node_id;
        match tier {
            Tier::Incremental { from, log_end } => {
                if from_replica {
                    lock(&partition.catch_up).record_position(
                        source,
                        request.last_seq_no,
                        log_end,
                        request.sync_session.is_some(),
                    );
                }
                let span = (from, log_end);
                self.send_sync_entries(message, respond, &partition, &request, span, &sync_session)
                    .await
            }
            Tier::Snapshot => {
                if from_replica {
                    lock(&partition.catch_up).record_snapshot_request(source);
                }
                Err(refused(
                    codes::SNAPSHOT_SYNC_SNAPSHOT_FAILED,
                    &request,
                    format!(
                        "Node '{}' no longer holds the entries that partition {} of index '{}' needs from sequence number {}, and it cannot send a snapshot of the partition",
                        self.node_id,
                        request.partition_id,
                        request.index_name,
                        request.last_seq_no + 1
                    ),
                )
                .with_detail("primaryNodeId", Value::from(self.node_id.as_str())))
            }
        }
    }

    pub(crate) async fn answer_sync_request(
        self: &Arc<Self>,
        message: &TransportMessage,
        respond: &Respond,
    ) {
        if let Err(error) = self.serve_sync(message, respond).await {
            respond.send(refusal(message, &self.node_id, &error)).await;
        }
    }
}
