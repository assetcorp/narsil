use super::index::IndexState;
use super::plugins::{PluginRegistry, WriteHook};
use super::reads;
use super::writes::{
    BatchFailure, BatchResult, NextDocumentId, insert_doc_id, provided_doc_id,
    require_matching_doc_id,
};
use crate::config::validate_doc_id;
use crate::error::Result;
use crate::value::Map;

/// Resolves the ID of one insert as the engine resolves it, then runs every `before_insert` hook on the document.
pub(crate) fn before_insert(
    plugins: &PluginRegistry,
    index_name: &str,
    document: &mut Map,
    doc_id: Option<&str>,
    next_id: &NextDocumentId<'_>,
) -> Result<String> {
    let id = insert_doc_id(doc_id, document, next_id)?;
    plugins.before_write(WriteHook::Insert, |plugin| {
        plugin.before_insert(index_name, &id, document)
    })?;
    Ok(id)
}

/// The documents of a batch insert that passed every `before_insert` hook, each with the ID that its hooks saw, and
/// a copy of each for the `after_insert` hooks.
pub(crate) struct HookedInserts {
    pub(crate) documents: Vec<Map>,
    pub(crate) ids: Vec<Option<String>>,
    pub(crate) kept: Vec<(String, Map)>,
    pub(crate) failed: Vec<BatchFailure>,
}

/// Runs every `before_insert` hook on each document of a batch, setting aside each document that a hook refuses.
pub(crate) fn before_insert_batch(
    plugins: &PluginRegistry,
    index_name: &str,
    documents: Vec<Map>,
    next_id: &NextDocumentId<'_>,
) -> HookedInserts {
    let mut hooked = HookedInserts {
        documents: Vec::with_capacity(documents.len()),
        ids: Vec::with_capacity(documents.len()),
        kept: Vec::with_capacity(documents.len()),
        failed: Vec::new(),
    };
    for mut document in documents {
        let fallback = provided_doc_id(&document).unwrap_or_default().to_string();
        match before_insert(plugins, index_name, &mut document, None, next_id) {
            Ok(id) => {
                hooked.kept.push((id.clone(), document.clone()));
                hooked.ids.push(Some(id));
                hooked.documents.push(document);
            }
            Err(error) => hooked.failed.push(BatchFailure {
                doc_id: fallback,
                error,
            }),
        }
    }
    hooked
}

/// Runs every `after_insert` hook on each document that the batch wrote, and adds the documents that a hook
/// refused to the batch's failures.
pub(crate) fn after_insert_batch(
    plugins: &PluginRegistry,
    index_name: &str,
    kept: Vec<(String, Map)>,
    failed: Vec<BatchFailure>,
    result: &mut BatchResult,
) {
    let mut written = result.succeeded.iter().peekable();
    for (id, document) in kept {
        if written.peek() != Some(&&id) {
            continue;
        }
        written.next();
        plugins.after(|plugin| plugin.after_insert(index_name, &id, &document));
    }
    add_refusals(failed, result);
}

/// Runs every `before_update` hook on the document that replaces `doc_id`, after the checks that come first in
/// every Narsil engine, and returns the document that the index holds now, or an empty map where it holds none.
pub(crate) fn before_update(
    plugins: &PluginRegistry,
    index: &IndexState,
    doc_id: &str,
    document: &mut Map,
) -> Result<Map> {
    validate_doc_id(doc_id)?;
    require_matching_doc_id(doc_id, document)?;
    let old = reads::get(index, doc_id)?.unwrap_or_default();
    plugins.before_write(WriteHook::Update, |plugin| {
        plugin.before_update(&index.name, doc_id, &old, document)
    })?;
    Ok(old)
}

/// Runs every `before_remove` hook on `doc_id`, after the ID check that comes first in every Narsil engine.
pub(crate) fn before_remove(
    plugins: &PluginRegistry,
    index_name: &str,
    doc_id: &str,
) -> Result<()> {
    validate_doc_id(doc_id)?;
    plugins.before_write(WriteHook::Remove, |plugin| {
        plugin.before_remove(index_name, doc_id)
    })
}

/// Moves each refusal of `failed` ahead of the batch's own failures, so that the result lists every refusal.
pub(crate) fn add_refusals(failed: Vec<BatchFailure>, result: &mut BatchResult) {
    let mut refused = failed;
    refused.append(&mut result.failed);
    result.failed = refused;
}
