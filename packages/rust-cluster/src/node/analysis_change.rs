use std::time::Duration;

use narsil::held_analysis::PendingAnalysisChange;
use narsil::{AnalysisChange, AnalysisSetting, StopWords, StopWordsSetting, Value};

use super::handle::ClusterNode;
use super::identity::generate_node_id;
use super::rebalance::refuse_hidden_generation;
use crate::constants::{
    ANALYSIS_CHANGE_POLL_INTERVAL_MS, BM25_TUNING_SPEC_VERSION, FOLDED_MATCHING_SPEC_VERSION,
    MAX_SETTINGS_REPLACEMENT_ATTEMPTS,
};
use crate::controller::{
    IndexMetadataSnapshot, PendingAnalysis, metadata_key, metadata_with_pending_analysis,
    metadata_without_pending_analysis, read_index_metadata_snapshot, validate_index_name,
};
use crate::error::{ClusterError, ClusterResult, codes};
use crate::rebalance::read_rebalance_record;
use crate::version::reaches_version;

const SETTINGS_CONTENTION_REASON: &str = "settings_contention";

struct NamedSettings {
    language: String,
    tokenizer: Option<String>,
    stop_words: Option<String>,
    stop_word_list: Option<Vec<String>>,
    fold_marks: Option<bool>,
}

impl From<PendingAnalysisChange> for NamedSettings {
    fn from(checked: PendingAnalysisChange) -> NamedSettings {
        NamedSettings {
            language: checked.language,
            tokenizer: checked.tokenizer,
            stop_words: checked.stop_words,
            stop_word_list: checked.stop_word_list,
            fold_marks: checked.fold_marks,
        }
    }
}

enum Outcome {
    Waiting,
    Published,
}

fn index_not_found(index_name: &str) -> ClusterError {
    ClusterError::new(
        codes::INDEX_NOT_FOUND,
        format!("Index '{index_name}' does not exist in the cluster"),
    )
    .with_detail("indexName", Value::from(index_name))
}

fn target_of(
    index_name: &str,
    current: &PendingAnalysis,
    change: &AnalysisChange,
) -> ClusterResult<NamedSettings> {
    let language = change
        .language
        .clone()
        .unwrap_or_else(|| current.language.clone());
    let tokenizer = match &change.tokenizer {
        AnalysisSetting::Keep => current.tokenizer.clone(),
        AnalysisSetting::LanguageDefault => None,
        AnalysisSetting::Set(name) => Some(name.clone()),
    };
    let (stop_words, stop_word_list) = match &change.stop_words {
        AnalysisSetting::Keep => (current.stop_words.clone(), current.stop_word_list.clone()),
        AnalysisSetting::LanguageDefault => (None, None),
        AnalysisSetting::Set(StopWordsSetting::Named(name)) => (Some(name.clone()), None),
        AnalysisSetting::Set(StopWordsSetting::Words(StopWords::Set(words))) => {
            let mut list: Vec<String> = words.iter().cloned().collect();
            list.sort();
            (None, Some(list))
        }
        AnalysisSetting::Set(StopWordsSetting::Words(StopWords::Function(_))) => {
            return Err(ClusterError::new(
                codes::CONFIG_INVALID,
                "A stop word function survives no restart, so an analysis change takes a registered stop word name or a list of words",
            )
            .with_detail("indexName", Value::from(index_name)));
        }
    };
    let fold_marks = match change.fold_marks {
        AnalysisSetting::Keep => current.fold_marks,
        AnalysisSetting::LanguageDefault => None,
        AnalysisSetting::Set(fold_marks) => Some(fold_marks),
    };
    Ok(NamedSettings {
        language,
        tokenizer,
        stop_words,
        stop_word_list,
        fold_marks,
    })
}

fn asks_for(pending: &PendingAnalysis, target: &NamedSettings) -> bool {
    pending.language == target.language
        && pending.tokenizer == target.tokenizer
        && pending.stop_words == target.stop_words
        && pending.stop_word_list == target.stop_word_list
        && pending.fold_marks == target.fold_marks
}

fn minimum_version_of(change: &AnalysisChange) -> &'static str {
    match change.fold_marks {
        AnalysisSetting::Keep => BM25_TUNING_SPEC_VERSION,
        _ => FOLDED_MATCHING_SPEC_VERSION,
    }
}

fn outcome_of(
    snapshot: &IndexMetadataSnapshot,
    pending: &PendingAnalysis,
    index_name: &str,
) -> ClusterResult<Outcome> {
    if snapshot.published_analysis().generation == pending.generation {
        return Ok(Outcome::Published);
    }
    if let Some(failure) = snapshot
        .analysis_failure()
        .filter(|failure| failure.change_id == pending.change_id)
    {
        return Err(ClusterError::new(failure.code, failure.message)
            .with_detail("indexName", Value::from(index_name))
            .with_detail("nodeId", Value::from(failure.node_id.as_str())));
    }
    if snapshot
        .pending_analysis()
        .is_some_and(|running| running.change_id == pending.change_id)
    {
        return Ok(Outcome::Waiting);
    }
    Err(ClusterError::new(
        codes::ANALYSIS_CHANGE_REPLACED,
        format!("A later change replaced this analysis change of index '{index_name}'"),
    )
    .with_detail("indexName", Value::from(index_name)))
}

impl ClusterNode {
    async fn write_pending(
        &self,
        index_name: &str,
        target: &NamedSettings,
    ) -> ClusterResult<Option<PendingAnalysis>> {
        let coordinator = self.inner.coordinator();
        for _ in 0..MAX_SETTINGS_REPLACEMENT_ATTEMPTS {
            let Some(snapshot) = read_index_metadata_snapshot(coordinator, index_name).await?
            else {
                return Err(index_not_found(index_name));
            };
            let running = snapshot.pending_analysis();
            if let Some(running) = running.as_ref().filter(|running| asks_for(running, target)) {
                return Ok(Some(running.clone()));
            }
            let published = snapshot.published_analysis();
            if running.is_none() && asks_for(&published, target) {
                return Ok(None);
            }
            let generation = published
                .generation
                .max(running.map_or(0.0, |running| running.generation))
                + 1.0;
            let pending = PendingAnalysis {
                change_id: generate_node_id()?,
                generation,
                language: target.language.clone(),
                tokenizer: target.tokenizer.clone(),
                stop_words: target.stop_words.clone(),
                stop_word_list: target.stop_word_list.clone(),
                fold_marks: target.fold_marks,
            };
            let next = metadata_with_pending_analysis(&snapshot, &pending)?;
            if coordinator
                .compare_and_set(&metadata_key(index_name), Some(&snapshot.bytes), &next)
                .await?
            {
                return Ok(Some(pending));
            }
        }
        Err(ClusterError::new(
            codes::CLUSTER_WRITE_BLOCKED,
            format!(
                "Index '{index_name}' kept changing while its analysis change was recorded {MAX_SETTINGS_REPLACEMENT_ATTEMPTS} times over, so the change was not stored. Retry the request"
            ),
        )
        .with_detail("reason", Value::from(SETTINGS_CONTENTION_REASON))
        .with_detail("indexName", Value::from(index_name))
        .with_detail("attempts", Value::from(MAX_SETTINGS_REPLACEMENT_ATTEMPTS)))
    }

    async fn clear_own_pending(&self, index_name: &str, change_id: &str) -> ClusterResult<()> {
        let coordinator = self.inner.coordinator();
        for _ in 0..MAX_SETTINGS_REPLACEMENT_ATTEMPTS {
            let Some(snapshot) = read_index_metadata_snapshot(coordinator, index_name).await?
            else {
                return Ok(());
            };
            if snapshot
                .pending_analysis()
                .is_none_or(|pending| pending.change_id != change_id)
            {
                return Ok(());
            }
            let next = metadata_without_pending_analysis(&snapshot)?;
            if coordinator
                .compare_and_set(&metadata_key(index_name), Some(&snapshot.bytes), &next)
                .await?
            {
                return Ok(());
            }
        }
        Ok(())
    }

    pub(super) async fn serving_name(&self, index_name: &str) -> ClusterResult<String> {
        Ok(self
            .inner
            .coordinator()
            .allocation(index_name)
            .await?
            .and_then(|table| table.generation)
            .unwrap_or_else(|| index_name.to_string()))
    }

    /// Changes the analysis settings of a cluster index, and returns once the controller publishes the new
    /// generation of its analysis.
    ///
    /// A node with the data role first checks the language, the tokenizer and stop word names, and the index's
    /// synonym rules under the new settings against its engine. The node then records the change as the index's
    /// pending analysis. The controller then asks every node that holds a
    /// copy to build the new terms beside the old ones, and publishes the change once each one answers, so the
    /// change finishes where this node dies. A later change replaces one that is still building, so the latest
    /// change wins, and a change to the settings that the index holds completes with no new generation.
    ///
    /// # Errors
    ///
    /// Fails with `LANGUAGE_NOT_SUPPORTED` for a language that a data node's engine does not hold, with
    /// `CONFIG_INVALID` for a stop word function, a name that starts with `narsil-generation-`, or, on a data node,
    /// an unregistered tokenizer or stop word name or a synonym word that breaks the rules under the new settings, with
    /// `INDEX_NOT_FOUND` where the cluster holds no such index, with `ANALYSIS_CHANGE_NOT_READY` where a registered
    /// node runs a specification version below 1.1, or below 1.6 for a change that sets `fold_marks`, with `CLUSTER_WRITE_BLOCKED` where the index's metadata kept
    /// changing over 5 attempts, with `PARTITION_REBALANCING_BACKPRESSURE` during a partition count change, with
    /// `ANALYSIS_CHANGE_REPLACED` where a later change replaces this one, with the code that a holder refused the
    /// change with, such as `LANGUAGE_NOT_SUPPORTED`, `CONFIG_INVALID`, or `ANALYSIS_REBUILD_MEMORY_EXCEEDED`, and
    /// with `NODE_NOT_JOINED` where the node shuts down while it waits.
    pub async fn change_analysis(
        &self,
        index_name: &str,
        change: &AnalysisChange,
    ) -> ClusterResult<()> {
        refuse_hidden_generation(index_name)?;
        self.track(
            Some(index_name),
            self.change_cluster_analysis(index_name, change),
        )
        .await
    }

    async fn change_cluster_analysis(
        &self,
        index_name: &str,
        change: &AnalysisChange,
    ) -> ClusterResult<()> {
        let coordinator = self.inner.coordinator();
        let serving = self.serving_name(index_name).await?;
        validate_index_name(&serving)?;
        let snapshot = read_index_metadata_snapshot(coordinator, &serving).await?;
        let (Some(schema), Some(snapshot)) = (coordinator.schema(&serving).await?, snapshot) else {
            return Err(index_not_found(index_name));
        };
        let target = match &self.inner.data {
            Some(data) => data
                .check_analysis_change(&serving, index_name, &schema, change)
                .await?
                .map(NamedSettings::from)
                .ok_or_else(|| index_not_found(index_name))?,
            None => target_of(index_name, &snapshot.published_analysis(), change)?,
        };
        let minimum = minimum_version_of(change);
        let older: Vec<Value> = coordinator
            .list_nodes()
            .await?
            .into_iter()
            .filter(|node| !reaches_version(&node.version, minimum))
            .map(|node| Value::String(node.node_id))
            .collect();
        if !older.is_empty() {
            return Err(ClusterError::new(
                codes::ANALYSIS_CHANGE_NOT_READY,
                format!(
                    "The cluster has nodes below the specification version that changes analysis, so index '{index_name}' keeps its settings until they are upgraded"
                ),
            )
            .with_detail("indexName", Value::from(index_name))
            .with_detail("nodeIds", Value::Array(older)));
        }
        let Some(pending) = self.write_pending(&serving, &target).await? else {
            return Ok(());
        };
        if read_rebalance_record(coordinator, index_name)
            .await?
            .is_some()
        {
            self.clear_own_pending(&serving, &pending.change_id).await?;
            return Err(ClusterError::new(
                codes::PARTITION_REBALANCING_BACKPRESSURE,
                format!(
                    "Index '{index_name}' is changing its partition count, so try its analysis change again once that ends"
                ),
            )
            .with_detail("indexName", Value::from(index_name)));
        }
        loop {
            self.guard_shutdown()?;
            let Some(snapshot) = read_index_metadata_snapshot(coordinator, &serving).await? else {
                return Err(index_not_found(index_name));
            };
            if let Outcome::Published = outcome_of(&snapshot, &pending, index_name)? {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(ANALYSIS_CHANGE_POLL_INTERVAL_MS)).await;
        }
    }
}
