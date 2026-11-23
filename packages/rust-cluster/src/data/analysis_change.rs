use std::sync::{Arc, Weak};

use narsil::held_analysis::{HeldAnalysisChanges, PendingAnalysisChange};
use narsil::{Map, Value, encode_msgpack};

use super::blocking::off_executor;
use super::copies::LocalCopies;
use crate::constants::MAX_SAFE_INTEGER;
use crate::controller::{PendingAnalysis, read_index_metadata_snapshot};
use crate::coordinator::etcd::{EtcdCoordinator, WatchHandle};
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::{TransportMessage, message_types};
use crate::node::{NodeErrorHandler, decode_request_payload, report_failure};

struct RebuildRequest {
    index_name: String,
    index_uuid: String,
    generation: Option<u64>,
}

fn non_empty_text(fields: &Map, key: &str) -> Option<String> {
    match fields.get(key) {
        Some(Value::String(text)) if !text.is_empty() => Some(text.clone()),
        _ => None,
    }
}

fn read_rebuild_request(message: &TransportMessage) -> ClusterResult<RebuildRequest> {
    let decoded = decode_request_payload(&message.payload, &message.message_type)?;
    let invalid = || {
        ClusterError::new(
            codes::CONFIG_INVALID,
            "Invalid RebuildAnalysisPayload: it needs an indexName, an indexUuid, and a generation of 1 or more where it carries one",
        )
    };
    let Value::Object(fields) = decoded else {
        return Err(invalid());
    };
    let generation = match fields.get("generation") {
        None | Some(Value::Null) => None,
        Some(Value::Number(generation))
            if generation.fract() == 0.0
                && *generation >= 1.0
                && *generation <= MAX_SAFE_INTEGER as f64 =>
        {
            Some(*generation as u64)
        }
        Some(_) => return Err(invalid()),
    };
    match (
        non_empty_text(&fields, "indexName"),
        non_empty_text(&fields, "indexUuid"),
    ) {
        (Some(index_name), Some(index_uuid)) => Ok(RebuildRequest {
            index_name,
            index_uuid,
            generation,
        }),
        _ => Err(invalid()),
    }
}

fn change_of(pending: &PendingAnalysis) -> PendingAnalysisChange {
    PendingAnalysisChange {
        generation: pending.generation as u64,
        language: pending.language.clone(),
        tokenizer: pending.tokenizer.clone(),
        stop_words: pending.stop_words.clone(),
        stop_word_list: pending.stop_word_list.clone(),
    }
}

fn rebuild_answer(
    message: &TransportMessage,
    node_id: &str,
    index_name: &str,
    rebuilt: &[u32],
    generation: Option<u64>,
) -> ClusterResult<TransportMessage> {
    let mut payload = Map::with_capacity(3);
    payload.insert("indexName", Value::String(index_name.to_string()));
    payload.insert(
        "rebuiltPartitions",
        Value::Array(
            rebuilt
                .iter()
                .map(|id| Value::Number(f64::from(*id)))
                .collect(),
        ),
    );
    if let Some(generation) = generation {
        payload.insert("generation", Value::Number(generation as f64));
    }
    let encoded = encode_msgpack(&Value::Object(payload)).map_err(ClusterError::from)?;
    Ok(TransportMessage::new(
        message_types::CLUSTER_REBUILD_ANALYSIS,
        node_id,
        &message.request_id,
        encoded,
    ))
}

fn replaced(index_name: &str, generation: u64) -> ClusterError {
    ClusterError::new(
        codes::ANALYSIS_CHANGE_REPLACED,
        format!(
            "A later change replaced generation {generation} of the analysis of index '{index_name}'"
        ),
    )
    .with_detail("indexName", Value::String(index_name.to_string()))
}

fn generation_missing(index_name: &str, requested: u64, held: u64) -> ClusterError {
    ClusterError::new(
        codes::ANALYSIS_GENERATION_MISSING,
        format!(
            "This node holds analysis generation {held} of index '{index_name}', so it cannot answer for generation {requested}"
        ),
    )
    .with_detail("indexName", Value::String(index_name.to_string()))
    .with_detail("requestedGeneration", Value::from(requested))
    .with_detail("heldGeneration", Value::from(held))
}

pub(super) struct AnalysisChanges {
    node_id: String,
    coordinator: Arc<EtcdCoordinator>,
    copies: Arc<LocalCopies>,
    on_error: Option<NodeErrorHandler>,
}

impl AnalysisChanges {
    pub(super) fn new(
        node_id: String,
        coordinator: Arc<EtcdCoordinator>,
        copies: Arc<LocalCopies>,
        on_error: Option<NodeErrorHandler>,
    ) -> Arc<AnalysisChanges> {
        Arc::new(AnalysisChanges {
            node_id,
            coordinator,
            copies,
            on_error,
        })
    }

    async fn on_engine<T, F>(&self, work: F) -> ClusterResult<T>
    where
        T: Send + 'static,
        F: FnOnce(HeldAnalysisChanges<'_>) -> narsil::Result<T> + Send + 'static,
    {
        let copies = Arc::clone(&self.copies);
        off_executor(move || work(HeldAnalysisChanges::new(&copies.engine)))
            .await?
            .map_err(ClusterError::from)
    }

    async fn holds_copy(&self, index_name: &str, index_uuid: &str) -> ClusterResult<bool> {
        let copies = Arc::clone(&self.copies);
        let name = index_name.to_string();
        let local = off_executor(move || copies.local_uuid(&name)).await??;
        Ok(local.as_deref() == Some(index_uuid))
    }

    async fn held_partitions(&self, index_name: &str) -> ClusterResult<Vec<u32>> {
        let copies = Arc::clone(&self.copies);
        let name = index_name.to_string();
        off_executor(move || copies.held_partition_ids(&name)).await?
    }

    async fn build_held_copies(
        self: &Arc<Self>,
        request: &RebuildRequest,
        generation: u64,
    ) -> ClusterResult<Vec<u32>> {
        let index_name = &request.index_name;
        if !self.holds_copy(index_name, &request.index_uuid).await? {
            return Ok(Vec::new());
        }
        let Some(snapshot) = read_index_metadata_snapshot(&self.coordinator, index_name).await?
        else {
            return Ok(Vec::new());
        };
        if snapshot.record.index_uuid != request.index_uuid
            || snapshot.published_analysis().generation >= generation as f64
        {
            return Ok(Vec::new());
        }
        let pending = snapshot
            .pending_analysis()
            .filter(|pending| pending.generation == generation as f64)
            .ok_or_else(|| replaced(index_name, generation))?;
        let change = change_of(&pending);
        let name = index_name.clone();
        self.on_engine(move |held| held.build_held_analysis(&name, &change))
            .await?;
        self.settle_in_background(index_name);
        self.held_partitions(index_name).await
    }

    async fn rebuild_local_copies(&self, request: &RebuildRequest) -> ClusterResult<Vec<u32>> {
        let index_name = &request.index_name;
        if !self.holds_copy(index_name, &request.index_uuid).await? {
            return Ok(Vec::new());
        }
        let copies = Arc::clone(&self.copies);
        let name = index_name.clone();
        let rebuilt = off_executor(move || {
            let stale = copies
                .engine
                .list_indexes()
                .iter()
                .any(|index| index.name == name && index.analysis_stale);
            if stale {
                copies.engine.rebuild_analysis(&name).map(|()| true)
            } else {
                Ok(false)
            }
        })
        .await??;
        if !rebuilt {
            return Ok(Vec::new());
        }
        self.held_partitions(index_name).await
    }

    pub(super) async fn answer_rebuild(
        self: &Arc<Self>,
        message: &TransportMessage,
    ) -> ClusterResult<TransportMessage> {
        let request = read_rebuild_request(message)?;
        let rebuilt = match request.generation {
            None => self.rebuild_local_copies(&request).await?,
            Some(generation) => self.build_held_copies(&request, generation).await?,
        };
        rebuild_answer(
            message,
            &self.node_id,
            &request.index_name,
            &rebuilt,
            request.generation,
        )
    }

    async fn settle(&self, index_name: &str) -> ClusterResult<()> {
        let Some(snapshot) = read_index_metadata_snapshot(&self.coordinator, index_name).await?
        else {
            return Ok(());
        };
        if !self
            .holds_copy(index_name, &snapshot.record.index_uuid)
            .await?
        {
            return Ok(());
        }
        let published = snapshot.published_analysis();
        let published_generation = published.generation as u64;
        let next = published_generation.saturating_add(1);
        let pending_generation = snapshot
            .pending_analysis()
            .map(|pending| pending.generation as u64);
        let name = index_name.to_string();
        let abandoned = self
            .on_engine(move |held| {
                Ok(held.held_analysis_is_built(&name, next) && pending_generation != Some(next))
            })
            .await?;
        if abandoned {
            let name = index_name.to_string();
            self.on_engine(move |held| held.drop_held_analysis(&name))
                .await?;
        }
        if published_generation == 0 {
            return Ok(());
        }
        let change = change_of(&published);
        let name = index_name.to_string();
        self.on_engine(move |held| {
            if !held.held_analysis_is_built(&name, change.generation) {
                held.build_held_analysis(&name, &change)?;
            }
            held.release_held_analysis(&name, change.generation)
        })
        .await
    }

    async fn generation_of(&self, index_name: &str) -> ClusterResult<Option<u64>> {
        let name = index_name.to_string();
        self.on_engine(move |held| Ok(held.analysis_generation(&name)))
            .await
    }

    async fn reach(self: &Arc<Self>, index_name: &str, requested: u64) {
        let name = index_name.to_string();
        let released = self
            .on_engine(move |held| {
                if !held.held_analysis_is_built(&name, requested) {
                    return Ok(false);
                }
                held.release_held_analysis(&name, requested).map(|()| true)
            })
            .await;
        match released {
            Ok(true) => {}
            Ok(false) => self.settle_in_background(index_name),
            Err(error) => report_failure(self.on_error.as_ref(), &error),
        }
    }

    pub(super) async fn answer_at<T, F, Fut>(
        self: &Arc<Self>,
        index_name: &str,
        requested: u64,
        read: F,
    ) -> ClusterResult<T>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = ClusterResult<T>>,
    {
        let Some(generation) = self.generation_of(index_name).await? else {
            return read().await;
        };
        if generation != requested {
            if generation < requested {
                self.reach(index_name, requested).await;
            }
            let reached = self.generation_of(index_name).await?.unwrap_or(generation);
            if reached != requested {
                return Err(generation_missing(index_name, requested, reached));
            }
        }
        let answer = read().await?;
        let after = self.generation_of(index_name).await?.unwrap_or(requested);
        if after != requested {
            return Err(generation_missing(index_name, requested, after));
        }
        Ok(answer)
    }

    fn settle_in_background(self: &Arc<Self>, index_name: &str) {
        let changes = Arc::clone(self);
        let index_name = index_name.to_string();
        tokio::spawn(async move {
            if let Err(error) = changes.settle(&index_name).await {
                report_failure(changes.on_error.as_ref(), &error);
            }
        });
    }

    pub(super) async fn watch(self: &Arc<Self>) -> ClusterResult<WatchHandle> {
        let owner: Weak<AnalysisChanges> = Arc::downgrade(self);
        let watch = self
            .coordinator
            .watch_index_metadata(move |event| {
                if let Some(changes) = owner.upgrade()
                    && event.metadata.is_some()
                {
                    changes.settle_in_background(&event.index_name);
                }
            })
            .await?;
        for index_name in self.coordinator.list_schemas().await? {
            self.settle_in_background(&index_name);
        }
        Ok(watch)
    }
}
