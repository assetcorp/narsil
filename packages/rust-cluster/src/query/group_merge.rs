use narsil::coordination::{GroupMergeRequest, group_identities, merge_groups};
use narsil::{Map, SortDirection, SortField, Value};

use super::merge::{ranks_by, sorted_entry_ranks};
use super::search_answer::{ScoredEntry, WireGroupEntry};
use super::wire_query::WireQuery;
use crate::error::{ClusterError, ClusterResult, codes};

const SCORE_WORD_BITS: usize = 32;

fn group_value_of(values: &Map, field: &str) -> Value {
    values.get(field).cloned().unwrap_or(Value::Null)
}

fn exceeds_layout() -> ClusterError {
    ClusterError::new(
        codes::CONFIG_INVALID,
        "The grouped results exceed the merge layout",
    )
}

pub(crate) fn merge_distributed_groups(
    per_node: &[Vec<WireGroupEntry>],
    fields: &[String],
    max_per_group: usize,
    limit: Option<usize>,
    sort_directions: Option<&[SortDirection]>,
) -> ClusterResult<Vec<WireGroupEntry>> {
    let sources: Vec<&WireGroupEntry> = per_node.iter().flatten().collect();
    let count: usize = sources.iter().map(|source| source.scored.len()).sum();
    if u32::try_from(count).is_err() || u32::try_from(sources.len()).is_err() {
        return Err(exceeds_layout());
    }
    let columns: Vec<Vec<Value>> = fields
        .iter()
        .map(|field| {
            sources
                .iter()
                .map(|source| group_value_of(&source.values, field))
                .collect()
        })
        .collect();
    let identities = group_identities(&columns, sources.len())?;
    let values: Vec<Map> = identities
        .heads
        .iter()
        .map(|&head| {
            let mut named = Map::with_capacity(fields.len());
            for field in fields {
                named.insert(field.as_str(), group_value_of(&sources[head].values, field));
            }
            named
        })
        .collect();
    let mut offsets = Vec::with_capacity(sources.len() + 1);
    let mut entries: Vec<ScoredEntry> = Vec::with_capacity(count);
    let mut scores = vec![0.0f64; count];
    let mut presence: Option<Vec<u32>> = None;
    let mut present = 0usize;
    for source in &sources {
        offsets.push(entries.len() as u32);
        for entry in &source.scored {
            let position = entries.len();
            match entry.score {
                Some(score) => {
                    scores[position] = score;
                    present += 1;
                }
                None => {
                    let words = presence.get_or_insert_with(|| {
                        vec![u32::MAX; count.div_ceil(SCORE_WORD_BITS).max(1)]
                    });
                    words[position / SCORE_WORD_BITS] &= !(1u32 << (position % SCORE_WORD_BITS));
                }
            }
            entries.push(entry.clone());
        }
    }
    offsets.push(entries.len() as u32);
    let id_ranks = ranks_by(entries.len(), |left, right| {
        entries[left].doc_id.cmp(&entries[right].doc_id)
    });
    let ranks = match sort_directions {
        None => id_ranks.clone(),
        Some(directions) => sorted_entry_ranks(&entries, directions)?,
    };
    let merged = merge_groups(&GroupMergeRequest {
        keys: &identities.keys,
        offsets: &offsets,
        scores: (present > 0).then_some(scores.as_slice()),
        score_present: presence.as_deref().filter(|_| present > 0),
        ranks: &ranks,
        id_ranks: &id_ranks,
        sorted: sort_directions.is_some(),
        max_per_group: u32::try_from(max_per_group).unwrap_or(u32::MAX),
        limit: limit.map(|limit| u32::try_from(limit).unwrap_or(u32::MAX)),
        key_count: values.len(),
    })?;
    merged
        .into_iter()
        .map(|group| {
            let scored = group
                .members
                .iter()
                .map(|&(source, index)| {
                    sources
                        .get(source)
                        .and_then(|source| source.scored.get(index))
                        .cloned()
                        .ok_or_else(exceeds_layout)
                })
                .collect::<ClusterResult<Vec<ScoredEntry>>>()?;
            let values = values
                .get(group.key as usize)
                .cloned()
                .ok_or_else(exceeds_layout)?;
            Ok(WireGroupEntry { values, scored })
        })
        .collect()
}

pub(crate) fn merge_groups_for(
    params: &WireQuery,
    all_groups: &[Vec<WireGroupEntry>],
    sort_fields: Option<&[SortField]>,
) -> ClusterResult<Option<Vec<WireGroupEntry>>> {
    let Some(group) = &params.group else {
        return Ok(None);
    };
    if all_groups.is_empty() {
        return Ok(None);
    }
    let directions: Option<Vec<SortDirection>> =
        sort_fields.map(|sort| sort.iter().map(|field| field.direction).collect());
    merge_distributed_groups(
        all_groups,
        &group.fields,
        group.max_per_group,
        group.limit,
        directions.as_deref(),
    )
    .map(Some)
}
