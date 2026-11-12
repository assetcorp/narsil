use std::collections::BTreeMap;

use super::EngineInner;
use super::index::IndexState;
use super::index_lifecycle::{ClosedListing, IndexResidencyState};
use crate::error::Result;
use crate::value::Map;

/// A summary of one index.
#[derive(Debug, Clone, PartialEq)]
pub struct IndexInfo {
    /// The name that calls reach the index by.
    pub name: String,
    /// The number of documents that the index holds, which a closed index reports as of its last checkpoint.
    pub document_count: u64,
    /// The number of partitions that the index spreads its documents across.
    pub partition_count: usize,
    /// The language that analyses the index's text.
    pub language: String,
    /// Whether the index's terms came from an earlier analysis than its language module produces now, which a
    /// closed index reports as `false` until it opens again.
    pub analysis_stale: bool,
    /// Whether the index is in memory, on its files after a close, or parked after five failed reopens in a row.
    pub state: IndexResidencyState,
    /// The number of times that this engine opened the index again from its files.
    pub reopen_count: u64,
}

pub(crate) fn list_indexes(engine: &EngineInner) -> Vec<IndexInfo> {
    engine.read_held_indexes(listed_indexes)
}

fn listed_indexes(open: &[&IndexState], closed: Vec<ClosedListing>) -> Vec<IndexInfo> {
    let mut listed: Vec<IndexInfo> = open
        .iter()
        .map(|index| IndexInfo {
            name: index.name.clone(),
            document_count: index.document_count(),
            partition_count: index.partitions().len(),
            language: index.analyser().language().name().to_string(),
            analysis_stale: index.analysis_stale(),
            state: IndexResidencyState::Open,
            reopen_count: index.residency.reopen_count(),
        })
        .collect();
    listed.extend(closed.into_iter().map(|listing| IndexInfo {
        name: listing.name,
        document_count: listing.closed.document_count,
        partition_count: listing.closed.partition_count,
        language: listing.closed.language,
        analysis_stale: false,
        state: listing.state,
        reopen_count: listing.reopen_count,
    }));
    listed.sort_by(|left, right| left.name.cmp(&right.name));
    listed
}

pub(crate) fn get(index: &IndexState, doc_id: &str) -> Result<Option<Map>> {
    index.full_document(doc_id)
}

pub(crate) fn get_multiple(
    index: &IndexState,
    doc_ids: &[String],
) -> Result<BTreeMap<String, Map>> {
    let mut found = BTreeMap::new();
    for doc_id in doc_ids {
        if let Some(document) = get(index, doc_id)? {
            found.insert(doc_id.clone(), document);
        }
    }
    Ok(found)
}

pub(crate) fn has(index: &IndexState, doc_id: &str) -> Result<bool> {
    let partitions = index.partitions();
    Ok(index.locate(&partitions, doc_id)?.is_some())
}
