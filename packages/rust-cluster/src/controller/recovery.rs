use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use narsil::{Map, Value, decode_msgpack, encode_msgpack};

use super::Inner;
use super::metadata::index_metadata;
use super::table::{TableWrite, put_allocation_over, rewrite_for_current_index, stored_table};
use crate::allocator::{Assignment, INITIALISING, Table, UNASSIGNED};
use crate::constants::{PARTITION_STORES_TIMEOUT_MS, RECOVERY_CAS_ATTEMPTS};
use crate::coordinator::NodeRegistration;
use crate::error::ClusterResult;
use crate::message::{TransportMessage, message_types};
use crate::node::generate_node_id;
use crate::transport::NodeTransport;

const HOLDER_OFFLINE: &str = "HOLDER_OFFLINE";
const HOLDER_UNREACHABLE: &str = "HOLDER_UNREACHABLE";
const HOLDER_IDENTITY_MISMATCH: &str = "HOLDER_IDENTITY_MISMATCH";
const HOLDER_WITHOUT_DATA: &str = "HOLDER_WITHOUT_DATA";

const NOTHING_TO_RECOVER: RecoveryOutcome = RecoveryOutcome {
    promoted: false,
    ask_again: false,
};

#[derive(Debug, Clone, Copy)]
pub(super) struct RecoveryOutcome {
    pub(super) promoted: bool,
    pub(super) ask_again: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RecoveryWrite {
    Promoted,
    Settled,
    Lost,
}

#[derive(Debug, Clone)]
enum StoresAnswer {
    Held(Vec<f64>),
    Unreachable,
    IdentityMismatch,
}

fn live_holders_of_unassigned(table: &Table, live: &HashMap<String, String>) -> Vec<String> {
    let mut holders: Vec<String> = table
        .assignments
        .values()
        .filter(|assignment| assignment.state == UNASSIGNED)
        .flat_map(|assignment| assignment.last_holders_of().iter().cloned())
        .filter(|node_id| live.contains_key(node_id))
        .collect::<HashSet<String>>()
        .into_iter()
        .collect();
    holders.sort();
    holders
}

fn has_recoverable_partition(table: &Table) -> bool {
    table.assignments.values().any(|assignment| {
        assignment.state == UNASSIGNED && !assignment.last_holders_of().is_empty()
    })
}

fn reason_for(
    assignment: &Assignment,
    live: &HashMap<String, String>,
    answers: &HashMap<String, StoresAnswer>,
) -> Option<&'static str> {
    let holders = assignment.last_holders_of();
    if holders.is_empty() {
        return None;
    }
    if holders.iter().any(|node_id| !live.contains_key(node_id)) {
        return Some(HOLDER_OFFLINE);
    }
    let given: Vec<Option<&StoresAnswer>> =
        holders.iter().map(|node_id| answers.get(node_id)).collect();
    if given
        .iter()
        .any(|answer| matches!(answer, None | Some(StoresAnswer::Unreachable)))
    {
        return Some(HOLDER_UNREACHABLE);
    }
    if given
        .iter()
        .any(|answer| matches!(answer, Some(StoresAnswer::IdentityMismatch)))
    {
        return Some(HOLDER_IDENTITY_MISMATCH);
    }
    Some(HOLDER_WITHOUT_DATA)
}

fn stores_request(index_name: &str, controller_node_id: &str) -> Option<TransportMessage> {
    let mut payload = Map::with_capacity(1);
    payload.insert("indexName", Value::String(index_name.to_string()));
    let encoded = encode_msgpack(&Value::Object(payload)).ok()?;
    let request_id = generate_node_id().ok()?;
    Some(TransportMessage::new(
        message_types::CLUSTER_PARTITION_STORES,
        controller_node_id,
        request_id,
        encoded,
    ))
}

fn read_answer(response: &TransportMessage, index_name: &str, index_uuid: &str) -> StoresAnswer {
    let Ok(Value::Object(answer)) = decode_msgpack(&response.payload) else {
        return StoresAnswer::Unreachable;
    };
    let answered_name = match answer.get("indexName") {
        Some(Value::String(name)) if !name.is_empty() => name,
        _ => return StoresAnswer::Unreachable,
    };
    let answered_uuid = match answer.get("indexUuid") {
        None | Some(Value::Null) => None,
        Some(Value::String(uuid)) => Some(uuid.as_str()),
        Some(_) => return StoresAnswer::Unreachable,
    };
    let Some(Value::Array(entries)) = answer.get("partitionIds") else {
        return StoresAnswer::Unreachable;
    };
    let mut partition_ids = Vec::with_capacity(entries.len());
    for entry in entries {
        match entry {
            Value::Number(id) if id.is_finite() && id.fract() == 0.0 && *id >= 0.0 => {
                partition_ids.push(*id);
            }
            _ => return StoresAnswer::Unreachable,
        }
    }
    if answered_name != index_name {
        return StoresAnswer::Unreachable;
    }
    if answered_uuid != Some(index_uuid) {
        return StoresAnswer::IdentityMismatch;
    }
    StoresAnswer::Held(partition_ids)
}

async fn ask_node_for_stores(
    transport: Arc<dyn NodeTransport>,
    targets: Vec<String>,
    request: TransportMessage,
    index_name: String,
    index_uuid: String,
) -> StoresAnswer {
    let wait = Duration::from_millis(PARTITION_STORES_TIMEOUT_MS);
    for target in &targets {
        if let Ok(Ok(response)) =
            tokio::time::timeout(wait, transport.send(target, request.clone())).await
        {
            return read_answer(&response, &index_name, &index_uuid);
        }
    }
    StoresAnswer::Unreachable
}

fn promoted(assignment: &Assignment, node_id: &str) -> Assignment {
    Assignment {
        primary: Some(node_id.to_string()),
        replicas: Vec::new(),
        in_sync_set: Vec::new(),
        primary_term: assignment.primary_term + 1.0,
        state: INITIALISING.to_string(),
        unassigned_reason: None,
        ..assignment.clone()
    }
}

fn rewritten(
    assignment: &Assignment,
    partition_id: f64,
    live: &HashMap<String, String>,
    answers: &HashMap<String, StoresAnswer>,
) -> Option<(Assignment, bool)> {
    let mut holders = assignment.last_holders_of().to_vec();
    holders.sort();
    let answered = holders.iter().find(|node_id| {
        matches!(answers.get(*node_id), Some(StoresAnswer::Held(ids)) if ids.contains(&partition_id))
    });
    if let Some(holder) = answered {
        return Some((promoted(assignment, holder), true));
    }
    let reason = reason_for(assignment, live, answers);
    if reason == assignment.unassigned_reason.as_deref() {
        return None;
    }
    let mut changed = assignment.clone();
    changed.unassigned_reason = reason.map(str::to_string);
    Some((changed, false))
}

impl Inner {
    async fn ask_holders(
        &self,
        holders: &[String],
        live: &HashMap<String, String>,
        index_name: &str,
        index_uuid: &str,
    ) -> HashMap<String, StoresAnswer> {
        let mut asks = tokio::task::JoinSet::new();
        for (position, node_id) in holders.iter().enumerate() {
            let mut targets = vec![node_id.clone()];
            if let Some(address) = live
                .get(node_id)
                .filter(|address| !address.is_empty() && *address != node_id)
            {
                targets.push(address.clone());
            }
            let Some(request) = stores_request(index_name, self.node_id()) else {
                continue;
            };
            let transport = Arc::clone(&self.config.transport);
            let ask = ask_node_for_stores(
                transport,
                targets,
                request,
                index_name.to_string(),
                index_uuid.to_string(),
            );
            asks.spawn(async move { (position, ask.await) });
        }
        let mut answers = HashMap::new();
        while let Some(finished) = asks.join_next().await {
            if let Ok((position, answer)) = finished {
                answers.insert(holders[position].clone(), answer);
            }
        }
        answers
    }

    async fn write_recovery_outcome(
        &self,
        index_name: &str,
        live: &HashMap<String, String>,
        answers: &HashMap<String, StoresAnswer>,
    ) -> ClusterResult<RecoveryWrite> {
        for _ in 0..RECOVERY_CAS_ATTEMPTS {
            if !self.is_active() {
                return Ok(RecoveryWrite::Settled);
            }
            let Some(table) = stored_table(self.coordinator(), index_name).await? else {
                return Ok(RecoveryWrite::Settled);
            };
            let mut next = table.clone();
            let mut any_rewritten = false;
            let mut any_promoted = false;
            for (partition_id, assignment) in table.assignments.iter() {
                if assignment.state != UNASSIGNED {
                    continue;
                }
                let Some((changed, was_promoted)) =
                    rewritten(assignment, partition_id, live, answers)
                else {
                    continue;
                };
                next.assignments.set(partition_id, changed);
                any_rewritten = true;
                any_promoted = any_promoted || was_promoted;
            }
            if !any_rewritten || !self.is_active() {
                return Ok(RecoveryWrite::Settled);
            }
            next.version = table.version + 1.0;
            let Some(next) = rewrite_for_current_index(self.coordinator(), next).await? else {
                return Ok(RecoveryWrite::Settled);
            };
            let write = TableWrite {
                index_name,
                previous: Some(&table),
                writer_node_id: self.node_id(),
                replica: None,
            };
            if put_allocation_over(self.coordinator(), write, next).await? {
                return Ok(if any_promoted {
                    RecoveryWrite::Promoted
                } else {
                    RecoveryWrite::Settled
                });
            }
        }
        Ok(RecoveryWrite::Lost)
    }

    pub(super) async fn recover_unassigned_partitions(
        &self,
        index_name: &str,
        nodes: &[NodeRegistration],
    ) -> ClusterResult<RecoveryOutcome> {
        let live: HashMap<String, String> = nodes
            .iter()
            .map(|node| (node.node_id.clone(), node.address.clone()))
            .collect();
        if !self.is_active() {
            return Ok(NOTHING_TO_RECOVER);
        }
        let Some(table) = stored_table(self.coordinator(), index_name).await? else {
            return Ok(NOTHING_TO_RECOVER);
        };
        if !has_recoverable_partition(&table) || !self.is_active() {
            return Ok(NOTHING_TO_RECOVER);
        }
        let mut answers = HashMap::new();
        let holders = live_holders_of_unassigned(&table, &live);
        if !holders.is_empty() {
            let Some(metadata) = index_metadata(self.coordinator(), index_name).await? else {
                return Ok(NOTHING_TO_RECOVER);
            };
            if !self.is_active() {
                return Ok(NOTHING_TO_RECOVER);
            }
            answers = self
                .ask_holders(&holders, &live, index_name, &metadata.index_uuid)
                .await;
        }
        let write = self
            .write_recovery_outcome(index_name, &live, &answers)
            .await?;
        let unanswered = holders
            .iter()
            .any(|holder| matches!(answers.get(holder), None | Some(StoresAnswer::Unreachable)));
        Ok(RecoveryOutcome {
            promoted: write == RecoveryWrite::Promoted,
            ask_again: write == RecoveryWrite::Lost || unanswered,
        })
    }
}
