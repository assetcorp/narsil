use std::collections::{BTreeMap, HashMap, HashSet};

use super::constants::{BUILD_LIST_PAGE, BUILD_WRITE_BATCH, SUGGESTIONS_INDEX_INFIX};
use super::known::suggestion_states;
use super::setting_wire::QuerySuggestionsSource;
use super::state::SuggestionState;
use crate::analysis::StopWords;
use crate::config::{IndexConfig, PartitionConfig, StopWordsSetting};
use crate::engine::changes::analysis::{AnalysisChange, AnalysisSetting};
use crate::engine::query::listing::ListParams;
use crate::engine::writes::BatchResult;
use crate::engine::{EngineInner, Narsil, lifecycle};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::value::{Map, Value};

/// The origin of a suggestion that a build published from the searches.
pub(crate) const ORIGIN_POPULAR: &str = "popular";
/// The origin of a suggestion that a caller added by hand.
pub(crate) const ORIGIN_MANUAL: &str = "manual";

/// One suggestion that a suggestions index holds.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct StoredSuggestion {
    pub(crate) count: f64,
    pub(crate) origin: String,
}

/// What a build changed in one suggestions index.
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct GroupChanges {
    pub(crate) published: u64,
    pub(crate) removed: u64,
}

/// What undoes the writes of a build to one suggestions index.
pub(crate) struct UndoStep {
    name: String,
    remove: Vec<String>,
    restore: Vec<(String, StoredSuggestion)>,
}

/// Returns the name of the suggestions index of `group` for `index_name`.
pub(crate) fn suggestions_index_name(index_name: &str, group: &str) -> String {
    format!("{index_name}{SUGGESTIONS_INDEX_INFIX}{group}")
}

/// Returns the document of one suggestion, whose ID is its phrase.
pub(crate) fn suggestion_document(phrase: &str, count: f64, origin: &str) -> Map {
    let mut document = Map::new();
    document.insert("id", Value::String(phrase.to_string()));
    document.insert("query", Value::String(phrase.to_string()));
    document.insert("count", Value::Number(count));
    document.insert("origin", Value::String(origin.to_string()));
    document
}

/// Returns the suggestions index of each group whose marker names `index_name`, keyed by group.
pub(crate) fn marked_suggestion_indexes(
    engine: &EngineInner,
    index_name: &str,
) -> BTreeMap<String, String> {
    let mut by_group = BTreeMap::new();
    for (name, state) in suggestion_states(engine) {
        if let Some(source) = &state.source
            && source.index == index_name
        {
            by_group.insert(source.group.clone(), name);
        }
    }
    by_group
}

fn suggestions_config(language: &str) -> IndexConfig {
    let mut schema = Map::new();
    schema.insert("query", Value::String("string".to_string()));
    schema.insert("count", Value::String("number".to_string()));
    schema.insert("origin", Value::String("enum".to_string()));
    IndexConfig {
        schema: Value::Object(schema),
        language: Some(language.to_string()),
        stop_words: Some(StopWordsSetting::Words(StopWords::Set(HashSet::new()))),
        partitions: Some(PartitionConfig {
            max_partitions: Some(1),
            ..PartitionConfig::default()
        }),
        ..IndexConfig::default()
    }
}

/// Returns the suggestions index of `group` for `index_name`, creating it with the language of the source index
/// where it is missing, and refusing with `CONFIG_INVALID` an index of that name without the right marker.
pub(crate) fn ensure_suggestions_index(
    narsil: &Narsil,
    index_name: &str,
    group: &str,
    created: &mut Vec<String>,
) -> Result<String> {
    let name = suggestions_index_name(index_name, group);
    let source = narsil.inner.reach_index(index_name)?;
    let language = source.analyser().language().name().to_string();
    let existing = match narsil.inner.reach_index(&name) {
        Ok(existing) => Some(existing),
        Err(error) if error.code() == ErrorCode::INDEX_NOT_FOUND => None,
        Err(error) => return Err(error),
    };
    let Some(existing) = existing else {
        let state = SuggestionState {
            source: Some(QuerySuggestionsSource {
                index: index_name.to_string(),
                group: group.to_string(),
            }),
            ..SuggestionState::default()
        };
        lifecycle::create_marked_index(&narsil.inner, &name, suggestions_config(&language), state)?;
        created.push(name.clone());
        return Ok(name);
    };
    let marked = existing
        .suggestion_state()
        .source
        .as_ref()
        .is_some_and(|source| source.index == index_name && source.group == group);
    if !marked {
        return Err(NarsilError::new(
            ErrorCode::CONFIG_INVALID,
            format!(
                "Index \"{name}\" exists without the marker of a suggestions index for \"{index_name}\", so the build leaves it alone"
            ),
        ));
    }
    if existing.analyser().language().name() != language {
        narsil.change_analysis(
            &name,
            &AnalysisChange {
                language: Some(language),
                tokenizer: AnalysisSetting::Keep,
                stop_words: AnalysisSetting::Keep,
            },
        )?;
    }
    Ok(name)
}

/// Returns every suggestion that the suggestions index `name` holds, keyed by phrase.
pub(crate) fn read_suggestions(
    narsil: &Narsil,
    name: &str,
) -> Result<HashMap<String, StoredSuggestion>> {
    let mut stored = HashMap::new();
    let mut cursor = None;
    loop {
        let page = narsil.list_documents(
            name,
            &ListParams {
                cursor,
                limit: Some(BUILD_LIST_PAGE),
                ..ListParams::default()
            },
        )?;
        for listed in page.documents {
            let count = listed
                .document
                .get("count")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            let origin = match listed.document.get("origin") {
                Some(Value::String(origin)) => origin.clone(),
                _ => ORIGIN_POPULAR.to_string(),
            };
            stored.insert(listed.id, StoredSuggestion { count, origin });
        }
        match page.cursor {
            Some(next) => cursor = Some(next),
            None => return Ok(stored),
        }
    }
}

fn require_written(result: &BatchResult) -> Result<()> {
    match result.failed.first() {
        Some(failure) => Err(failure.error.clone()),
        None => Ok(()),
    }
}

fn remove_batch_of(narsil: &Narsil, name: &str, ids: &[String]) -> Result<Vec<String>> {
    let result = narsil.remove_batch(name, ids.to_vec())?;
    if let Some(failure) = result
        .failed
        .iter()
        .find(|failure| failure.error.code() != ErrorCode::DOC_NOT_FOUND)
    {
        return Err(failure.error.clone());
    }
    Ok(result.succeeded)
}

/// Removes the suggestions `ids` from the suggestions index `name`, skipping each that it lacks, and returns how
/// many it removed.
pub(crate) fn remove_suggestions(narsil: &Narsil, name: &str, ids: &[String]) -> Result<u64> {
    let mut removed = 0;
    for batch in ids.chunks(BUILD_WRITE_BATCH) {
        removed += remove_batch_of(narsil, name, batch)?.len() as u64;
    }
    Ok(removed)
}

/// Undoes the writes of a build, newest first, leaving out each banned phrase that a write removed.
pub(crate) fn undo_writes(
    narsil: &Narsil,
    steps: &[UndoStep],
    banned: &HashSet<String>,
) -> Result<()> {
    for step in steps.iter().rev() {
        remove_suggestions(narsil, &step.name, &step.remove)?;
        let restore: Vec<&(String, StoredSuggestion)> = step
            .restore
            .iter()
            .filter(|(phrase, _)| !banned.contains(phrase))
            .collect();
        for batch in restore.chunks(BUILD_WRITE_BATCH) {
            let phrases: Vec<String> = batch.iter().map(|(phrase, _)| phrase.clone()).collect();
            remove_suggestions(narsil, &step.name, &phrases)?;
            let documents = batch
                .iter()
                .map(|(phrase, stored)| suggestion_document(phrase, stored.count, &stored.origin))
                .collect();
            require_written(&narsil.insert_batch(&step.name, documents)?)?;
        }
    }
    Ok(())
}

/// Brings the suggestions index `name` to the phrases that are `due`, keeping each manual suggestion, removing
/// each banned phrase, and removing each stale popular one unless `only_add` holds. It records in `undo` what
/// undoes each write that succeeded.
pub(crate) fn write_group(
    narsil: &Narsil,
    name: &str,
    due: &[(String, u64)],
    banned: &HashSet<String>,
    only_add: bool,
    undo: &mut Vec<UndoStep>,
) -> Result<GroupChanges> {
    let stored = read_suggestions(narsil, name)?;
    let due_phrases: HashSet<&str> = due.iter().map(|(phrase, _)| phrase.as_str()).collect();
    let mut inserts = Vec::new();
    let mut updates = Vec::new();
    for (phrase, count) in due {
        if banned.contains(phrase) {
            continue;
        }
        match stored.get(phrase) {
            None => inserts.push(suggestion_document(phrase, *count as f64, ORIGIN_POPULAR)),
            Some(current) if current.origin == ORIGIN_POPULAR && current.count != *count as f64 => {
                updates.push((phrase.clone(), *count, current.clone()));
            }
            Some(_) => {}
        }
    }
    let mut stale = Vec::new();
    let mut banned_held = Vec::new();
    for (phrase, current) in &stored {
        if banned.contains(phrase) {
            banned_held.push(phrase.clone());
        } else if !only_add
            && current.origin == ORIGIN_POPULAR
            && !due_phrases.contains(phrase.as_str())
        {
            stale.push((phrase.clone(), current.clone()));
        }
    }
    stale.sort_by(|left, right| left.0.cmp(&right.0));
    undo.push(UndoStep {
        name: name.to_string(),
        remove: Vec::new(),
        restore: Vec::new(),
    });
    let published = (inserts.len() + updates.len()) as u64;
    let mut removed = 0;
    let mut documents = inserts.into_iter();
    loop {
        let batch: Vec<Map> = documents.by_ref().take(BUILD_WRITE_BATCH).collect();
        if batch.is_empty() {
            break;
        }
        let result = narsil.insert_batch(name, batch)?;
        if let Some(step) = undo.last_mut() {
            step.remove.extend(result.succeeded.iter().cloned());
        }
        require_written(&result)?;
    }
    for batch in updates.chunks(BUILD_WRITE_BATCH) {
        let changes = batch
            .iter()
            .map(|(phrase, count, _)| {
                (
                    phrase.clone(),
                    suggestion_document(phrase, *count as f64, ORIGIN_POPULAR),
                )
            })
            .collect();
        let result = narsil.update_batch(name, changes)?;
        let succeeded: HashSet<&String> = result.succeeded.iter().collect();
        if let Some(step) = undo.last_mut() {
            for (phrase, _, previous) in batch {
                if succeeded.contains(phrase) {
                    step.restore.push((phrase.clone(), previous.clone()));
                }
            }
        }
        require_written(&result)?;
    }
    for batch in stale.chunks(BUILD_WRITE_BATCH) {
        let phrases: Vec<String> = batch.iter().map(|(phrase, _)| phrase.clone()).collect();
        let succeeded: HashSet<String> = remove_batch_of(narsil, name, &phrases)?
            .into_iter()
            .collect();
        removed += succeeded.len() as u64;
        if let Some(step) = undo.last_mut() {
            step.restore.extend(
                batch
                    .iter()
                    .filter(|(phrase, _)| succeeded.contains(phrase))
                    .cloned(),
            );
        }
    }
    removed += remove_suggestions(narsil, name, &banned_held)?;
    Ok(GroupChanges { published, removed })
}
