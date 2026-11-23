use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use narsil::{Map, Value, decode_msgpack, encode_msgpack};

use super::analysis_metadata::{
    AnalysisFailure, IndexMetadataSnapshot, PendingAnalysis, metadata_publishing_analysis,
    metadata_with_analysis_failure, read_index_metadata_snapshot,
};
use super::metadata::metadata_key;
use super::table::stored_table;
use super::{Inner, lock};
use crate::constants::{
    ANALYSIS_CHANGE_POLL_INTERVAL_MS, ANALYSIS_CHANGE_RETRY_MS, ANALYSIS_REBUILD_RESEND_MS,
};
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::{TransportMessage, message_types};
use crate::node::generate_node_id;
use crate::transport::NodeTransport;

const REFUSALS_THAT_FAIL_A_CHANGE: [&str; 3] = [
    codes::ANALYSIS_REBUILD_MEMORY_EXCEEDED,
    codes::LANGUAGE_NOT_SUPPORTED,
    codes::CONFIG_INVALID,
];

const ERROR_MESSAGE_SUFFIX: &str = ".error";

pub(crate) type AnalysisDriver = Arc<AtomicBool>;

struct ChangeProgress {
    change_id: String,
    answered: HashSet<String>,
    asking: HashMap<String, u64>,
    refusal: Option<AnalysisFailure>,
}

type SharedProgress = Arc<Mutex<ChangeProgress>>;

fn progress_of(change_id: &str) -> SharedProgress {
    Arc::new(Mutex::new(ChangeProgress {
        change_id: change_id.to_string(),
        answered: HashSet::new(),
        asking: HashMap::new(),
        refusal: None,
    }))
}

fn targets_of_registered_node(node_id: &str, address: &str) -> Vec<String> {
    if address.is_empty() || address == node_id {
        vec![node_id.to_string()]
    } else {
        vec![address.to_string(), node_id.to_string()]
    }
}

fn rebuild_payload(index_name: &str, index_uuid: &str, generation: f64) -> Map {
    let mut payload = Map::with_capacity(3);
    payload.insert("indexName", Value::String(index_name.to_string()));
    payload.insert("indexUuid", Value::String(index_uuid.to_string()));
    payload.insert("generation", Value::Number(generation));
    payload
}

fn refusal_of(response: &TransportMessage) -> Option<ClusterError> {
    let decoded = decode_msgpack(&response.payload).ok();
    let reply = match &decoded {
        Some(Value::Object(reply)) => Some(reply),
        _ => None,
    };
    let flagged = reply.is_some_and(|reply| matches!(reply.get("error"), Some(Value::Bool(true))));
    if !response.message_type.ends_with(ERROR_MESSAGE_SUFFIX) && !flagged {
        return None;
    }
    let text = |key: &str| {
        reply
            .and_then(|reply| reply.get(key))
            .and_then(Value::as_str)
    };
    Some(ClusterError::new(
        text("code").unwrap_or(codes::QUERY_ROUTING_FAILED),
        text("message").unwrap_or("The node refused an analysis rebuild"),
    ))
}

async fn send_rebuild(
    transport: &dyn NodeTransport,
    controller_node_id: &str,
    targets: &[String],
    payload: &Map,
) -> ClusterResult<()> {
    let encoded = encode_msgpack(&Value::Object(payload.clone())).map_err(ClusterError::from)?;
    let message = TransportMessage::new(
        message_types::CLUSTER_REBUILD_ANALYSIS,
        controller_node_id,
        generate_node_id()?,
        encoded,
    );
    let mut last_error = ClusterError::new(
        codes::QUERY_ROUTING_FAILED,
        "The node holds no address to send an analysis rebuild to",
    );
    for target in targets {
        match transport.send(target, message.clone()).await {
            Ok(response) => {
                return match refusal_of(&response) {
                    None => Ok(()),
                    Some(refusal) => Err(refusal),
                };
            }
            Err(error) => last_error = error,
        }
    }
    Err(last_error)
}

fn ask_holder(
    inner: &Arc<Inner>,
    progress: &SharedProgress,
    holder: String,
    targets: Vec<String>,
    payload: Map,
) {
    let ask = inner.next_sequence();
    lock(progress).asking.insert(holder.clone(), ask);
    let stop_asking = {
        let progress = Arc::clone(progress);
        let holder = holder.clone();
        move || {
            let mut progress = lock(&progress);
            if progress.asking.get(&holder) == Some(&ask) {
                progress.asking.remove(&holder);
            }
        }
    };
    let resend = stop_asking.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(ANALYSIS_REBUILD_RESEND_MS)).await;
        resend();
    });
    let transport = Arc::clone(&inner.config.transport);
    let controller_node_id = inner.node_id().to_string();
    let progress = Arc::clone(progress);
    tokio::spawn(async move {
        let outcome =
            send_rebuild(transport.as_ref(), &controller_node_id, &targets, &payload).await;
        {
            let mut progress = lock(&progress);
            match outcome {
                Ok(()) => {
                    progress.answered.insert(holder.clone());
                }
                Err(error) if REFUSALS_THAT_FAIL_A_CHANGE.contains(&error.code()) => {
                    progress.refusal = Some(AnalysisFailure {
                        change_id: progress.change_id.clone(),
                        code: error.code().to_string(),
                        message: error.message().to_string(),
                        node_id: holder.clone(),
                    });
                }
                Err(_) => {}
            }
        }
        stop_asking();
    });
}

impl Inner {
    async fn registered_holders(
        &self,
        index_name: &str,
    ) -> ClusterResult<Option<Vec<(String, Vec<String>)>>> {
        let Some(table) = stored_table(self.coordinator(), index_name).await? else {
            return Ok(None);
        };
        let registered: HashMap<String, String> = self
            .coordinator()
            .list_nodes()
            .await?
            .into_iter()
            .map(|node| (node.node_id, node.address))
            .collect();
        let mut holders = Vec::new();
        let mut seen = HashSet::new();
        for assignment in table.assignments.values() {
            let removing = assignment.removing_replicas.as_deref().unwrap_or_default();
            let copies = assignment
                .primary
                .iter()
                .chain(assignment.replicas.iter())
                .chain(removing.iter());
            for node_id in copies {
                let Some(address) = registered.get(node_id) else {
                    continue;
                };
                if seen.insert(node_id.clone()) {
                    holders.push((
                        node_id.clone(),
                        targets_of_registered_node(node_id, address),
                    ));
                }
            }
        }
        Ok(Some(holders))
    }

    async fn step_change(
        self: &Arc<Self>,
        index_name: &str,
        snapshot: &IndexMetadataSnapshot,
        pending: &PendingAnalysis,
        progress: &SharedProgress,
    ) -> ClusterResult<()> {
        let key = metadata_key(index_name);
        let refusal = lock(progress).refusal.clone();
        if let Some(refusal) = refusal {
            let next = metadata_with_analysis_failure(snapshot, &refusal)?;
            self.coordinator()
                .compare_and_set(&key, Some(&snapshot.bytes), &next)
                .await?;
            return Ok(());
        }
        let holders = self
            .registered_holders(index_name)
            .await?
            .unwrap_or_default();
        let payload = rebuild_payload(index_name, &snapshot.record.index_uuid, pending.generation);
        let mut waiting = false;
        for (holder, targets) in holders {
            let asking = {
                let progress = lock(progress);
                if progress.answered.contains(&holder) {
                    continue;
                }
                progress.asking.contains_key(&holder)
            };
            waiting = true;
            if !asking {
                ask_holder(self, progress, holder, targets, payload.clone());
            }
        }
        if !waiting {
            let next = metadata_publishing_analysis(snapshot, pending)?;
            self.coordinator()
                .compare_and_set(&key, Some(&snapshot.bytes), &next)
                .await?;
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(ANALYSIS_CHANGE_POLL_INTERVAL_MS)).await;
        Ok(())
    }

    async fn drive_changes(self: &Arc<Self>, index_name: &str) -> ClusterResult<()> {
        let mut progress = progress_of("");
        while self.is_active() {
            let Some(snapshot) =
                read_index_metadata_snapshot(self.coordinator(), index_name).await?
            else {
                return Ok(());
            };
            let Some(pending) = snapshot.pending_analysis() else {
                return Ok(());
            };
            if lock(&progress).change_id != pending.change_id {
                progress = progress_of(&pending.change_id);
            }
            self.step_change(index_name, &snapshot, &pending, &progress)
                .await?;
        }
        Ok(())
    }

    pub(super) fn start_analysis_driver(self: &Arc<Self>, index_name: &str) {
        let driver: AnalysisDriver = {
            let mut state = lock(&self.state);
            if let Some(running) = state.analysis_drivers.get(index_name) {
                running.store(true, Ordering::Release);
                return;
            }
            let driver = Arc::new(AtomicBool::new(false));
            state
                .analysis_drivers
                .insert(index_name.to_string(), Arc::clone(&driver));
            driver
        };
        let inner = Arc::clone(self);
        let index_name = index_name.to_string();
        tokio::spawn(async move {
            loop {
                driver.store(false, Ordering::Release);
                if let Err(error) = inner.drive_changes(&index_name).await {
                    inner.report(&index_name, &error);
                    driver.store(true, Ordering::Release);
                    tokio::time::sleep(Duration::from_millis(ANALYSIS_CHANGE_RETRY_MS)).await;
                }
                let mut state = lock(&inner.state);
                if driver.load(Ordering::Acquire) && inner.is_active() {
                    continue;
                }
                let owned = state
                    .analysis_drivers
                    .get(&index_name)
                    .is_some_and(|current| Arc::ptr_eq(current, &driver));
                if owned {
                    state.analysis_drivers.remove(&index_name);
                }
                return;
            }
        });
    }

    pub(super) async fn resume_analysis_drivers(self: &Arc<Self>) -> ClusterResult<()> {
        for index_name in self.coordinator().list_schemas().await? {
            let snapshot = read_index_metadata_snapshot(self.coordinator(), &index_name).await?;
            if snapshot.is_some_and(|snapshot| snapshot.pending_analysis().is_some()) {
                self.start_analysis_driver(&index_name);
            }
        }
        Ok(())
    }
}
