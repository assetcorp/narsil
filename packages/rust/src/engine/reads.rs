use std::collections::BTreeMap;

use super::index::IndexState;
use super::index_lifecycle::{ClosedListing, IndexResidencyState};
use super::query::projected::projected_document;
use super::query::projection::resolve_projection;
use super::{DocumentProjection, EngineInner, Narsil};
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
    engine.read_held_indexes(|open, closed| {
        let mut listed = listed_indexes(open, closed);
        engine.listing.arrange(&mut listed, |info| &info.name);
        listed
    })
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
    listed
}

pub(crate) fn get(
    index: &IndexState,
    doc_id: &str,
    projection: Option<&DocumentProjection>,
) -> Result<Option<Map>> {
    let projection = resolve_projection(projection, index);
    projected_document(index, doc_id, &projection)
}

pub(crate) fn get_multiple(
    index: &IndexState,
    doc_ids: &[String],
    projection: Option<&DocumentProjection>,
) -> Result<BTreeMap<String, Map>> {
    let projection = resolve_projection(projection, index);
    let mut found = BTreeMap::new();
    for doc_id in doc_ids {
        if let Some(document) = projected_document(index, doc_id, &projection)? {
            found.insert(doc_id.clone(), document);
        }
    }
    Ok(found)
}

pub(crate) fn has(index: &IndexState, doc_id: &str) -> Result<bool> {
    let partitions = index.partitions();
    Ok(index.locate(&partitions, doc_id)?.is_some())
}

impl Narsil {
    /// Returns the document stored under `doc_id`, or `None` where the index holds none.
    ///
    /// The document leaves out every vector field unless the index sets [`crate::IndexConfig::return_vectors`], and
    /// [`Narsil::get_with`] takes a projection that asks for them.
    pub fn get(&self, index: &str, doc_id: &str) -> Result<Option<Map>> {
        self.get_with(index, doc_id, None)
    }

    /// Returns the document stored under `doc_id`, cut down to the fields that `projection` keeps, or `None` where
    /// the index holds none.
    ///
    /// A `None` projection keeps every field apart from the vector fields that the read leaves out, as
    /// [`DocumentProjection`] describes, and [`DocumentProjection::None`] returns an empty map for a stored document.
    pub fn get_with(
        &self,
        index: &str,
        doc_id: &str,
        projection: Option<&DocumentProjection>,
    ) -> Result<Option<Map>> {
        self.inner
            .read_index(index, |state| get(state, doc_id, projection))
    }

    /// Returns the documents stored under each of `doc_ids` that the index holds, keyed by ID.
    ///
    /// Each document leaves out every vector field unless the index sets [`crate::IndexConfig::return_vectors`],
    /// and [`Narsil::get_multiple_with`] takes a projection that asks for them.
    pub fn get_multiple(&self, index: &str, doc_ids: &[String]) -> Result<BTreeMap<String, Map>> {
        self.get_multiple_with(index, doc_ids, None)
    }

    /// Returns the documents stored under each of `doc_ids` that the index holds, keyed by ID, each cut down to the
    /// fields that `projection` keeps, as [`Narsil::get_with`] cuts one document.
    pub fn get_multiple_with(
        &self,
        index: &str,
        doc_ids: &[String],
        projection: Option<&DocumentProjection>,
    ) -> Result<BTreeMap<String, Map>> {
        self.inner
            .read_index(index, |state| get_multiple(state, doc_ids, projection))
    }

    /// Reports whether the index holds a document under `doc_id`.
    pub fn has(&self, index: &str, doc_id: &str) -> Result<bool> {
        self.inner.read_index(index, |state| has(state, doc_id))
    }

    /// Returns the number of documents in the index.
    pub fn count_documents(&self, index: &str) -> Result<u64> {
        self.inner
            .read_index(index, |state| Ok(state.document_count()))
    }
}
