use std::sync::Arc;

use narsil::{
    IndexConfig, Map, Narsil, StopWordsSetting, SynonymRule, TokenizerSetting, Value,
    index_config_from_stored_settings,
};

use super::super::index_settings::encoded_rules;
use crate::constants::{MAX_SETTINGS_REPLACEMENT_ATTEMPTS, SETTINGS_CONTENTION_REASON};
use crate::controller::{
    IndexMetadataSnapshot, metadata_key, metadata_with_synonym_set, read_index_metadata_snapshot,
    validate_index_name,
};
use crate::coordinator::etcd::EtcdCoordinator;
use crate::data::stored_synonym_rules;
use crate::data::synonym_set::{
    SynonymSetRef, delete_synonym_set, store_synonym_set, synonym_set_ref, synonym_set_ref_value,
};
use crate::error::{ClusterError, ClusterResult, codes};
use crate::node::handle::ClusterNode;
use crate::reads::{ReadDeps, live_serving_name};
use crate::rebalance::read_rebalance_record;

const NAMED_ANALYSIS_FIELDS: [&str; 3] = ["tokenizer", "stopWords", "stopWordList"];

fn index_not_found(index_name: &str) -> ClusterError {
    ClusterError::new(
        codes::INDEX_NOT_FOUND,
        format!("Index '{index_name}' does not exist in the cluster"),
    )
    .with_detail("indexName", Value::from(index_name))
}

fn names_registered_analysis(config: &IndexConfig) -> bool {
    matches!(config.tokenizer, Some(TokenizerSetting::Named(_)))
        || matches!(config.stop_words, Some(StopWordsSetting::Named(_)))
}

fn check_rules_under(
    index_name: &str,
    mut config: IndexConfig,
    rules: &[SynonymRule],
) -> ClusterResult<()> {
    if names_registered_analysis(&config) {
        return Ok(());
    }
    config.synonyms = None;
    config.embedding = None;
    let engine = Narsil::new();
    engine.create_index(index_name, config)?;
    engine.update_synonyms(index_name, rules)?;
    Ok(())
}

fn pending_settings(settings: &Map, snapshot: &IndexMetadataSnapshot) -> Option<Map> {
    let pending = snapshot.pending_analysis()?;
    let mut changed = settings.clone();
    changed.insert("language", Value::from(pending.language.as_str()));
    for field in NAMED_ANALYSIS_FIELDS {
        changed.remove(field);
    }
    if let Some(tokenizer) = &pending.tokenizer {
        changed.insert("tokenizer", Value::from(tokenizer.as_str()));
    }
    if let Some(stop_words) = &pending.stop_words {
        changed.insert("stopWords", Value::from(stop_words.as_str()));
    }
    if let Some(list) = &pending.stop_word_list {
        changed.insert(
            "stopWordList",
            Value::Array(list.iter().cloned().map(Value::String).collect()),
        );
    }
    Some(changed)
}

fn check_rules(
    serving: &str,
    schema: &Value,
    snapshot: &IndexMetadataSnapshot,
    rules: &[SynonymRule],
) -> ClusterResult<()> {
    let settings = snapshot.settings.clone().unwrap_or_default();
    if let Some(pending) = pending_settings(&settings, snapshot) {
        check_rules_under(
            serving,
            index_config_from_stored_settings(schema.clone(), &pending)?,
            rules,
        )?;
    }
    check_rules_under(
        serving,
        index_config_from_stored_settings(schema.clone(), &settings)?,
        rules,
    )
}

async fn require_settled(
    coordinator: &EtcdCoordinator,
    deps: &ReadDeps,
    index_name: &str,
    serving: &str,
) -> ClusterResult<()> {
    let settled = read_rebalance_record(coordinator, index_name)
        .await?
        .is_none()
        && live_serving_name(deps, index_name).await? == serving;
    if settled {
        return Ok(());
    }
    Err(ClusterError::new(
        codes::PARTITION_REBALANCING_BACKPRESSURE,
        format!(
            "Index '{index_name}' is changing its partition count, so replace its synonym set again once that ends"
        ),
    )
    .with_detail("indexName", Value::from(index_name)))
}

async fn swap_stored_set(
    coordinator: &EtcdCoordinator,
    serving: &str,
    first: IndexMetadataSnapshot,
    reference: Option<&SynonymSetRef>,
) -> ClusterResult<Option<SynonymSetRef>> {
    let index_uuid = first.record.index_uuid.clone();
    let key = metadata_key(serving);
    let mut current = Some(first);
    for attempt in 1.. {
        let Some(snapshot) = current.filter(|snapshot| snapshot.record.index_uuid == index_uuid)
        else {
            return Err(index_not_found(serving));
        };
        let replaced = snapshot
            .synonym_set()
            .and_then(|raw| synonym_set_ref(raw).ok());
        let next = metadata_with_synonym_set(&snapshot, reference.map(synonym_set_ref_value))?;
        if coordinator
            .compare_and_set(&key, Some(&snapshot.bytes), &next)
            .await?
        {
            return Ok(replaced);
        }
        if attempt >= MAX_SETTINGS_REPLACEMENT_ATTEMPTS {
            return Err(ClusterError::new(
                codes::CLUSTER_WRITE_BLOCKED,
                format!(
                    "Index '{serving}' kept changing while its synonym set was replaced {attempt} times over, so the new set was not stored. Retry the request"
                ),
            )
            .with_detail("reason", Value::from(SETTINGS_CONTENTION_REASON))
            .with_detail("indexName", Value::from(serving))
            .with_detail("attempts", Value::from(attempt)));
        }
        current = read_index_metadata_snapshot(coordinator, serving).await?;
    }
    Err(index_not_found(serving))
}

impl ClusterNode {
    async fn replace_stored_synonyms(
        &self,
        deps: &Arc<ReadDeps>,
        index_name: &str,
        rules: &[SynonymRule],
    ) -> ClusterResult<()> {
        let coordinator = self.inner.coordinator();
        validate_index_name(index_name)?;
        let serving = live_serving_name(deps, index_name).await?;
        require_settled(coordinator, deps, index_name, &serving).await?;
        let Some(first) = read_index_metadata_snapshot(coordinator, &serving).await? else {
            return Err(index_not_found(index_name));
        };
        let schema = coordinator
            .schema(&serving)
            .await?
            .unwrap_or(Value::Object(Map::new()));
        check_rules(&serving, &schema, &first, rules)?;
        let index_uuid = first.record.index_uuid.clone();
        let reference = match encoded_rules(rules)? {
            Some(encoded) => Some(store_synonym_set(coordinator, &index_uuid, &encoded).await?),
            None => None,
        };
        let replaced = match swap_stored_set(coordinator, &serving, first, reference.as_ref()).await
        {
            Ok(replaced) => replaced,
            Err(error) => {
                if let Some(reference) = &reference {
                    let _ = delete_synonym_set(coordinator, &index_uuid, reference).await;
                }
                return Err(error);
            }
        };
        if let Some(replaced) = replaced
            && reference.as_ref().map(|written| &written.generation) != Some(&replaced.generation)
        {
            delete_synonym_set(coordinator, &index_uuid, &replaced).await?;
        }
        self.apply_synonyms_on_holders(deps, &serving, &index_uuid)
            .await?;
        require_settled(coordinator, deps, index_name, &serving).await
    }

    /// Returns the synonym set of a cluster index, as its metadata stores it, or an empty list where it holds none.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` for a name that starts with `narsil-generation-`, with
    /// `CONTROLLER_METADATA_INVALID` for a malformed name or stored set, with `INDEX_NOT_FOUND` where the cluster
    /// holds no such index, and with `NODE_NOT_JOINED` before the node joins or once it shuts down.
    pub async fn synonyms(&self, index_name: &str) -> ClusterResult<Vec<SynonymRule>> {
        let reads = self.inner.reads()?;
        self.track(Some(index_name), async {
            validate_index_name(index_name)?;
            let serving = live_serving_name(&reads, index_name).await?;
            stored_synonym_rules(self.inner.coordinator(), &serving)
                .await?
                .ok_or_else(|| index_not_found(index_name))
        })
        .await
    }

    /// Replaces the synonym set of a cluster index: the node checks the rules against the index's analysis, stores
    /// the set beside the metadata, points the metadata at it, and asks every node that holds a copy to apply it.
    /// An empty list removes the set.
    ///
    /// # Errors
    ///
    /// Fails as [`ClusterNode::synonyms`] does, with `CONFIG_INVALID` where a rule breaks a limit or holds a word
    /// that the index analyses to no token or to several, with `PARTITION_REBALANCING_BACKPRESSURE` while the
    /// index changes its partition count, with `CLUSTER_WRITE_BLOCKED` where the metadata kept changing over 5
    /// attempts, with `QUERY_NODE_TIMEOUT` where a holder did not answer, and with a holder's own refusal.
    pub async fn replace_synonyms(
        &self,
        index_name: &str,
        rules: &[SynonymRule],
    ) -> ClusterResult<()> {
        let reads = self.inner.reads()?;
        self.track(
            Some(index_name),
            self.replace_stored_synonyms(&reads, index_name, rules),
        )
        .await
    }
}
