use std::collections::{HashMap, HashSet};

use narsil::coordination::{fold_group_reducer, hits_kept_by_group};
use narsil::{GroupReducer, GroupResult, Hit, Map, QueryParams, Value};

use super::projection::{ResolvedProjection, apply_projection};
use super::ranked_documents::{RankedDocumentReader, RankedRead};
use crate::constants::MAX_FETCH_DOCUMENT_IDS;
use crate::error::ClusterResult;
use crate::query::search_answer::WireGroupEntry;

pub(crate) struct GroupReads {
    pub(crate) vectors: bool,
    pub(crate) reads_later: bool,
}

fn projected_group_document(document: Option<&Map>, projection: &ResolvedProjection) -> Map {
    match (document, projection) {
        (None, _) | (_, ResolvedProjection::Nothing) => Map::new(),
        (Some(document), projection) => apply_projection(document.clone(), projection),
    }
}

fn group_values(values: &Map) -> Vec<(String, Option<Value>)> {
    values
        .iter()
        .map(|(field, value)| {
            let held = match value {
                Value::Null => None,
                value => Some(value.clone()),
            };
            (field.clone(), held)
        })
        .collect()
}

fn assemble_group(
    entry: &WireGroupEntry,
    documents: &HashMap<String, Map>,
    kept_per_group: usize,
    projection: &ResolvedProjection,
    reduce: Option<&GroupReducer>,
) -> GroupResult {
    let hits = entry
        .scored
        .iter()
        .take(kept_per_group)
        .map(|scored| Hit {
            id: scored.doc_id.clone(),
            score: scored.score,
            document: projected_group_document(documents.get(&scored.doc_id), projection),
            score_components: None,
            highlights: None,
        })
        .collect();
    let mut result = GroupResult {
        values: group_values(&entry.values),
        hits,
        reduced: None,
        reducer_error: None,
    };
    let Some(reduce) = reduce else {
        return result;
    };
    let rows = entry
        .scored
        .iter()
        .map(|scored| (documents.get(&scored.doc_id), scored.score.unwrap_or(0.0)));
    let (reduced, reducer_error) = fold_group_reducer(reduce, rows);
    result.reduced = reduced;
    result.reducer_error = reducer_error;
    result
}

pub(crate) async fn assemble_distributed_groups(
    params: &QueryParams,
    wire_groups: Option<&[WireGroupEntry]>,
    projection: &ResolvedProjection,
    reader: &mut RankedDocumentReader,
    reads: GroupReads,
) -> ClusterResult<Option<Vec<GroupResult>>> {
    let (Some(wire_groups), Some(group)) = (wire_groups, &params.group) else {
        return Ok(None);
    };
    let reduce = group.reduce.as_ref();
    let needs_documents = reduce.is_some() || *projection != ResolvedProjection::Nothing;
    let kept_per_group = hits_kept_by_group(group.max_per_group);
    let ids_read = |entry: &WireGroupEntry| -> Vec<String> {
        let taken = match reduce {
            None => kept_per_group,
            Some(_) => entry.scored.len(),
        };
        entry
            .scored
            .iter()
            .take(taken)
            .map(|scored| scored.doc_id.clone())
            .collect()
    };
    let read_for = |last: bool| RankedRead {
        last: last && !reads.reads_later,
        fields: None,
        vectors: reads.vectors || reduce.is_some(),
        require_every_partition: true,
    };
    let mut results = Vec::with_capacity(wire_groups.len());
    let mut batch: Vec<&WireGroupEntry> = Vec::new();
    let mut batch_ids: Vec<String> = Vec::new();
    let mut batch_seen: HashSet<String> = HashSet::new();
    let mut entries = wire_groups.iter().peekable();
    while let Some(entry) = entries.next() {
        let ids = ids_read(entry);
        if !batch.is_empty() && batch_seen.len() + ids.len() > MAX_FETCH_DOCUMENT_IDS {
            let documents = match needs_documents && !batch_ids.is_empty() {
                true => reader.read(&batch_ids, read_for(false)).await?,
                false => HashMap::new(),
            };
            for held in batch.drain(..) {
                results.push(assemble_group(
                    held,
                    &documents,
                    kept_per_group,
                    projection,
                    reduce,
                ));
            }
            batch_ids.clear();
            batch_seen.clear();
        }
        batch.push(entry);
        for id in ids {
            if batch_seen.insert(id.clone()) {
                batch_ids.push(id);
            }
        }
        if entries.peek().is_none() {
            let documents = match needs_documents && !batch_ids.is_empty() {
                true => reader.read(&batch_ids, read_for(true)).await?,
                false => HashMap::new(),
            };
            for held in batch.drain(..) {
                results.push(assemble_group(
                    held,
                    &documents,
                    kept_per_group,
                    projection,
                    reduce,
                ));
            }
        }
    }
    Ok(Some(results))
}
