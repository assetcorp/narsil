use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

use narsil::coordination::{SortKeyOrder, merge_facet_buckets, merge_ranked_lists, merge_scored};
use narsil::{SortDirection, Value};

use super::search_answer::{FacetBuckets, ScoredEntry};
use crate::error::{ClusterError, ClusterResult, codes};
use crate::reads::query_conversion::DistributedFacets;

fn exceeds_layout() -> ClusterError {
    ClusterError::new(
        codes::CONFIG_INVALID,
        "The search rankings or limit exceed the merge layout",
    )
}

fn flattened(lists: Vec<Vec<ScoredEntry>>) -> (Vec<usize>, Vec<ScoredEntry>) {
    let mut bounds = Vec::with_capacity(lists.len() + 1);
    let mut entries = Vec::with_capacity(lists.iter().map(Vec::len).sum());
    for list in lists {
        bounds.push(entries.len());
        entries.extend(list);
    }
    bounds.push(entries.len());
    (bounds, entries)
}

pub(crate) fn merge_and_truncate_scored_entries(
    lists: Vec<Vec<ScoredEntry>>,
    limit: usize,
) -> ClusterResult<Vec<ScoredEntry>> {
    if u32::try_from(limit).is_err() {
        return Err(exceeds_layout());
    }
    let places = {
        let ranked: Vec<Vec<(Option<f64>, &str)>> = lists
            .iter()
            .map(|list| {
                list.iter()
                    .map(|entry| (entry.score, entry.doc_id.as_str()))
                    .collect()
            })
            .collect();
        merge_scored(&ranked, limit)?
    };
    let mut held: Vec<Vec<Option<ScoredEntry>>> = lists
        .into_iter()
        .map(|list| list.into_iter().map(Some).collect())
        .collect();
    Ok(places
        .into_iter()
        .filter_map(|(list, index)| {
            held.get_mut(list)
                .and_then(|entries| entries.get_mut(index))
                .and_then(Option::take)
        })
        .collect())
}

fn sort_key(entry: &ScoredEntry, width: usize) -> Vec<Value> {
    let mut key: Vec<Value> = entry
        .sort_values
        .as_deref()
        .unwrap_or_default()
        .iter()
        .take(width)
        .cloned()
        .collect();
    key.resize(width, Value::Null);
    key
}

pub(crate) fn sorted_entry_ranks(
    entries: &[ScoredEntry],
    directions: &[SortDirection],
) -> ClusterResult<Vec<u32>> {
    if u32::try_from(entries.len()).is_err() {
        return Err(exceeds_layout());
    }
    let keys: Vec<Vec<Value>> = entries
        .iter()
        .map(|entry| sort_key(entry, directions.len()))
        .collect();
    let order = SortKeyOrder::new(&keys)?;
    let compare = |left: usize, right: usize| -> Ordering {
        order
            .compare(left, right, directions)
            .then_with(|| entries[left].doc_id.cmp(&entries[right].doc_id))
    };
    Ok(ranks_by(entries.len(), compare))
}

pub(crate) fn ranks_by(count: usize, compare: impl Fn(usize, usize) -> Ordering) -> Vec<u32> {
    let mut order: Vec<usize> = (0..count).collect();
    order.sort_by(|left, right| compare(*left, *right));
    let mut ranks = vec![0u32; count];
    let mut rank = 0u32;
    for (place, &at) in order.iter().enumerate() {
        if place > 0 && compare(order[place - 1], at) != Ordering::Equal {
            rank += 1;
        }
        ranks[at] = rank;
    }
    ranks
}

pub(crate) fn merge_and_truncate_sorted_entries(
    lists: Vec<Vec<ScoredEntry>>,
    limit: usize,
    directions: &[SortDirection],
) -> ClusterResult<Vec<ScoredEntry>> {
    if u32::try_from(limit).is_err() {
        return Err(exceeds_layout());
    }
    let (bounds, entries) = flattened(lists);
    let ranks = sorted_entry_ranks(&entries, directions)?;
    let places = merge_ranked_lists(&bounds, &ranks, limit)?;
    let mut held: Vec<Option<ScoredEntry>> = entries.into_iter().map(Some).collect();
    Ok(places
        .into_iter()
        .filter_map(|at| held.get_mut(at).and_then(Option::take))
        .collect())
}

fn count_in_layout(count: u64) -> ClusterResult<u32> {
    u32::try_from(count).map_err(|_| {
        ClusterError::new(
            codes::CONFIG_INVALID,
            "A facet count exceeds the merge layout",
        )
    })
}

pub(crate) fn merge_distributed_facets(
    all_facets: &[FacetBuckets],
    all_bounds: &[Option<BTreeMap<String, u64>>],
    max_buckets: usize,
    ascending: &BTreeSet<String>,
) -> ClusterResult<DistributedFacets> {
    let mut fields: Vec<&str> = Vec::new();
    for facets in all_facets {
        for (field, _) in facets {
            if !fields.contains(&field.as_str()) {
                fields.push(field);
            }
        }
    }
    let sources = all_facets.len().max(all_bounds.len());
    let mut merged = DistributedFacets {
        facets: Vec::with_capacity(fields.len()),
        error_bounds: BTreeMap::new(),
        undercounts: BTreeMap::new(),
    };
    for field in fields {
        let mut lists = Vec::with_capacity(sources);
        let mut bounds = Vec::with_capacity(sources);
        for source in 0..sources {
            let buckets = all_facets
                .get(source)
                .and_then(|facets| facets.iter().find(|(held, _)| held == field))
                .map(|(_, buckets)| buckets.as_slice())
                .unwrap_or_default();
            lists.push(
                buckets
                    .iter()
                    .map(|(value, count)| Ok((value.clone(), count_in_layout(*count)?)))
                    .collect::<ClusterResult<Vec<(String, u32)>>>()?,
            );
            let bound = all_bounds
                .get(source)
                .and_then(Option::as_ref)
                .and_then(|bounds| bounds.get(field))
                .copied()
                .unwrap_or(0);
            bounds.push(count_in_layout(bound)?);
        }
        let result = merge_facet_buckets(
            &lists,
            &bounds,
            ascending.contains(field),
            Some(max_buckets),
        )?;
        merged.facets.push((
            field.to_string(),
            result
                .buckets
                .into_iter()
                .map(|(value, count)| (value, u64::from(count)))
                .collect(),
        ));
        merged
            .undercounts
            .insert(field.to_string(), u64::from(result.undercount));
        merged
            .error_bounds
            .insert(field.to_string(), u64::from(result.error_bound));
    }
    Ok(merged)
}
