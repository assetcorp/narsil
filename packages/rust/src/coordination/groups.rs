use crate::engine::GroupReducer;
use crate::engine::query::grouping::{fold_documents, group_values};
use crate::value::Map;

/// Folds the documents of one group through `reduce`, as one engine folds a group, and returns the folded value or
/// the text of the error or panic that stopped the fold. A row without a document adds nothing.
pub fn fold_group_reducer<'d>(
    reduce: &GroupReducer,
    rows: impl Iterator<Item = (Option<&'d Map>, f64)>,
) -> (Option<Value>, Option<String>) {
    fold_documents(reduce, rows)
}
use crate::error::{ErrorCode, NarsilError, Result};
use crate::ffi;
use crate::native::status::core_refused;
use crate::native::workspace::with_workspace;
use crate::value::Value;

/// The groups that equal value tuples form, as one engine's grouping forms them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValueGroups {
    /// For each tuple, the group that holds it.
    pub keys: Vec<u32>,
    /// For each group, the first tuple that it holds.
    pub heads: Vec<usize>,
}

/// Groups `count` value tuples, where `columns[field][tuple]` holds one value of a tuple and a missing value counts
/// as `Value::Null`, and returns the group of each tuple, the groups numbered in the order of their first tuple.
///
/// # Errors
///
/// Fails with `CONFIG_INVALID` where the values exceed the native group layout.
pub fn group_identities(columns: &[Vec<Value>], count: usize) -> Result<ValueGroups> {
    let groups = group_values(columns, count)?;
    Ok(ValueGroups {
        keys: groups.keys,
        heads: groups.heads,
    })
}

/// The groups of many nodes to merge into one list of groups.
pub struct GroupMergeRequest<'a> {
    /// For each source group, the key of its value tuple.
    pub keys: &'a [u32],
    /// The first entry of each source group, followed by the entry count.
    pub offsets: &'a [u32],
    /// The score of each entry, or `None` where no entry carries one.
    pub scores: Option<&'a [f64]>,
    /// A bit per entry, set where the entry carries a score, or `None` where every entry carries one.
    pub score_present: Option<&'a [u32]>,
    /// The place of each entry in the merge order.
    pub ranks: &'a [u32],
    /// The place of each entry's document id in code-point order.
    pub id_ranks: &'a [u32],
    /// Whether `ranks` follows a sort, where entries otherwise merge by score.
    pub sorted: bool,
    /// The entries that each merged group keeps.
    pub max_per_group: u32,
    /// The merged groups to keep, or `None` for every group.
    pub limit: Option<u32>,
    /// The number of distinct keys.
    pub key_count: usize,
}

/// One merged group: its key, and each entry that it keeps as the source group and the place within it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergedGroup {
    /// The key of the group's value tuple.
    pub key: u32,
    /// The entries that the group keeps, in merge order.
    pub members: Vec<(usize, usize)>,
}

fn exceeds_layout() -> NarsilError {
    NarsilError::new(
        ErrorCode::CONFIG_INVALID,
        "The grouped results exceed the merge layout",
    )
}

/// Merges groups that several nodes formed, so that the groups with equal keys become one group that keeps its best
/// entries, the groups ordered by their first entry.
///
/// # Errors
///
/// Fails with `CONFIG_INVALID` where the groups exceed the native merge layout or the request is malformed.
pub fn merge_groups(request: &GroupMergeRequest<'_>) -> Result<Vec<MergedGroup>> {
    let entries = request.ranks.len();
    if u32::try_from(entries).is_err() || u32::try_from(request.key_count).is_err() {
        return Err(exceeds_layout());
    }
    let scores = request.scores.unwrap_or_default();
    let present = request.score_present.unwrap_or_default();
    let mut keys = vec![0u32; request.key_count];
    let mut offsets = vec![0u32; request.key_count + 1];
    let mut sources = vec![0u32; entries];
    let mut indices = vec![0u32; entries];
    let native_request = ffi::narsil_group_merge_request {
        keys: request.keys.as_ptr(),
        key_count: request.keys.len(),
        offsets: request.offsets.as_ptr(),
        offset_count: request.offsets.len(),
        scores: scores.as_ptr(),
        score_count: scores.len(),
        score_present: present.as_ptr(),
        score_present_count: present.len(),
        ranks: request.ranks.as_ptr(),
        rank_count: request.ranks.len(),
        id_ranks: request.id_ranks.as_ptr(),
        id_rank_count: request.id_ranks.len(),
        has_scores: u32::from(request.scores.is_some()),
        has_score_present: u32::from(request.score_present.is_some()),
        sorted: u32::from(request.sorted),
        max_per_group: request.max_per_group,
        has_limit: u32::from(request.limit.is_some()),
        limit: request.limit.unwrap_or(0),
    };
    let mut output = ffi::narsil_group_merge_output {
        keys: keys.as_mut_ptr(),
        key_capacity: keys.len(),
        offsets: offsets.as_mut_ptr(),
        offset_capacity: offsets.len(),
        sources: sources.as_mut_ptr(),
        source_capacity: sources.len(),
        indices: indices.as_mut_ptr(),
        index_capacity: indices.len(),
        count: 0,
    };
    let status = with_workspace(|workspace| {
        Ok(unsafe { ffi::narsil_merge_groups(workspace, &native_request, &mut output) })
    })?;
    if status != ffi::NARSIL_OK {
        return Err(core_refused("a merge of groups", status));
    }
    let found = output.count as usize;
    let mut merged = Vec::with_capacity(found);
    for group in 0..found {
        let range = offsets[group] as usize..offsets[group + 1] as usize;
        merged.push(MergedGroup {
            key: keys[group],
            members: range
                .map(|at| (sources[at] as usize, indices[at] as usize))
                .collect(),
        });
    }
    Ok(merged)
}
