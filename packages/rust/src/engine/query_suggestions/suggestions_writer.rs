use std::collections::{BTreeMap, HashMap, HashSet};

use super::constants::{BUILD_LIST_PAGE, BUILD_WRITE_BATCH, SUGGESTIONS_INDEX_INFIX};
use super::host::SuggestionsHost;
use super::types::QuerySuggestionsSource;
use crate::analysis::StopWords;
use crate::config::{IndexConfig, PartitionConfig, StopWordsSetting};
use crate::engine::changes::analysis::{AnalysisChange, AnalysisSetting};
use crate::engine::query::listing::ListParams;
use crate::engine::writes::BatchResult;
use crate::error::{ErrorCode, Result};
use crate::format::metadata_parts::config_invalid;
use crate::value::{Map, Value};

const ORIGIN_POPULAR: &str = "popular";
pub(crate) const ORIGIN_MANUAL: &str = "manual";

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct StoredSuggestion {
    pub(crate) count: f64,
    origin: String,
}

#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct GroupChanges {
    pub(crate) published: u64,
    pub(crate) removed: u64,
}

pub(crate) struct UndoStep {
    name: String,
    remove: Vec<String>,
    restore: Vec<(String, StoredSuggestion)>,
}

pub(crate) fn suggestions_index_name(index_name: &str, group: &str) -> String {
    format!("{index_name}{SUGGESTIONS_INDEX_INFIX}{group}")
}

pub(crate) fn suggestion_document(phrase: &str, count: f64, origin: &str) -> Map {
    let mut document = Map::new();
    document.insert("id", Value::String(phrase.to_string()));
    document.insert("query", Value::String(phrase.to_string()));
    document.insert("count", Value::Number(count));
    document.insert("origin", Value::String(origin.to_string()));
    document
}

pub(crate) fn marked_suggestion_indexes(
    host: &dyn SuggestionsHost,
    index_name: &str,
) -> BTreeMap<String, String> {
    let mut by_group = BTreeMap::new();
    for (name, state) in host.states() {
        if let Some(source) = &state.source
            && source.index == index_name
        {
            by_group.insert(source.group.clone(), name);
        }
    }
    by_group
}

pub(crate) fn suggestions_config(language: &str) -> IndexConfig {
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

pub(crate) fn ensure_suggestions_index(
    host: &dyn SuggestionsHost,
    index_name: &str,
    group: &str,
    created: &mut Vec<String>,
) -> Result<String> {
    let name = suggestions_index_name(index_name, group);
    let language = host.language(index_name)?;
    let Some(existing) = host.state(&name) else {
        let source = QuerySuggestionsSource {
            index: index_name.to_string(),
            group: group.to_string(),
        };
        host.create_suggestions_index(&name, &source, &language)?;
        created.push(name.clone());
        return Ok(name);
    };
    let marked = existing
        .source
        .as_ref()
        .is_some_and(|source| source.index == index_name && source.group == group);
    if !marked {
        return Err(config_invalid(format!(
            "Index \"{name}\" exists without the marker of a suggestions index for \"{index_name}\", so the build leaves it alone"
        ))
        .with_details([("indexName", crate::value::Value::from(name.as_str()))]));
    }
    if host.language(&name)? != language {
        host.change_analysis(
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

pub(crate) fn read_suggestions(
    host: &dyn SuggestionsHost,
    name: &str,
) -> Result<HashMap<String, StoredSuggestion>> {
    let mut stored = HashMap::new();
    let mut cursor = None;
    loop {
        let page = host.list_documents(
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

fn remove_batch_of(host: &dyn SuggestionsHost, name: &str, ids: &[String]) -> Result<Vec<String>> {
    let result = host.remove_batch(name, ids.to_vec())?;
    if let Some(failure) = result
        .failed
        .iter()
        .find(|failure| failure.error.code() != ErrorCode::DOC_NOT_FOUND)
    {
        return Err(failure.error.clone());
    }
    Ok(result.succeeded)
}

pub(crate) fn remove_suggestions(
    host: &dyn SuggestionsHost,
    name: &str,
    ids: &[String],
) -> Result<u64> {
    let mut removed = 0;
    for batch in ids.chunks(BUILD_WRITE_BATCH) {
        removed += remove_batch_of(host, name, batch)?.len() as u64;
    }
    Ok(removed)
}

pub(crate) fn undo_writes(
    host: &dyn SuggestionsHost,
    steps: &[UndoStep],
    banned: &HashSet<String>,
) -> Result<()> {
    for step in steps.iter().rev() {
        remove_suggestions(host, &step.name, &step.remove)?;
        let restore: Vec<&(String, StoredSuggestion)> = step
            .restore
            .iter()
            .filter(|(phrase, _)| !banned.contains(phrase))
            .collect();
        for batch in restore.chunks(BUILD_WRITE_BATCH) {
            let phrases: Vec<String> = batch.iter().map(|(phrase, _)| phrase.clone()).collect();
            remove_suggestions(host, &step.name, &phrases)?;
            let documents = batch
                .iter()
                .map(|(phrase, stored)| suggestion_document(phrase, stored.count, &stored.origin))
                .collect();
            require_written(&host.insert_batch(&step.name, documents)?)?;
        }
    }
    Ok(())
}

pub(crate) fn write_group(
    host: &dyn SuggestionsHost,
    name: &str,
    due: &[(String, u64)],
    banned: &HashSet<String>,
    only_add: bool,
    undo: &mut Vec<UndoStep>,
) -> Result<GroupChanges> {
    let stored = read_suggestions(host, name)?;
    let mut step = UndoStep {
        name: name.to_string(),
        remove: Vec::new(),
        restore: Vec::new(),
    };
    let changes = write_changes(host, &stored, due, banned, only_add, &mut step);
    undo.push(step);
    changes
}

fn write_changes(
    host: &dyn SuggestionsHost,
    stored: &HashMap<String, StoredSuggestion>,
    due: &[(String, u64)],
    banned: &HashSet<String>,
    only_add: bool,
    step: &mut UndoStep,
) -> Result<GroupChanges> {
    let name = step.name.clone();
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
    for (phrase, current) in stored {
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
    let published = (inserts.len() + updates.len()) as u64;
    let mut documents = inserts.into_iter();
    loop {
        let batch: Vec<Map> = documents.by_ref().take(BUILD_WRITE_BATCH).collect();
        if batch.is_empty() {
            break;
        }
        let result = host.insert_batch(&name, batch)?;
        step.remove.extend(result.succeeded.iter().cloned());
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
        let result = host.update_batch(&name, changes)?;
        let succeeded: HashSet<&String> = result.succeeded.iter().collect();
        for (phrase, _, previous) in batch {
            if succeeded.contains(phrase) {
                step.restore.push((phrase.clone(), previous.clone()));
            }
        }
        require_written(&result)?;
    }
    let mut removed = 0;
    for batch in stale.chunks(BUILD_WRITE_BATCH) {
        let phrases: Vec<String> = batch.iter().map(|(phrase, _)| phrase.clone()).collect();
        let succeeded: HashSet<String> = remove_batch_of(host, &name, &phrases)?
            .into_iter()
            .collect();
        removed += succeeded.len() as u64;
        step.restore.extend(
            batch
                .iter()
                .filter(|(phrase, _)| succeeded.contains(phrase))
                .cloned(),
        );
    }
    removed += remove_suggestions(host, &name, &banned_held)?;
    Ok(GroupChanges { published, removed })
}
