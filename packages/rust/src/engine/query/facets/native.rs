use crate::error::Result;
use crate::ffi;
use crate::index::core_values::CoreStoredValues;
use crate::native::status::{query_accepted, query_refused};
use crate::native::workspace::with_workspace;

const NO_MATCHES: [u32; 1] = [0];

pub(super) struct NumericEntries<'a> {
    pub(super) values: &'a [f64],
    pub(super) ordinals: &'a [u32],
}

pub(super) struct FacetLists {
    pub(super) offsets: Vec<u32>,
    pub(super) keys: Vec<u32>,
    pub(super) counts: Vec<u32>,
    pub(super) bounds: Vec<u32>,
    pub(super) ranks: Vec<u32>,
}

pub(super) struct MergedFacet {
    pub(super) keys: Vec<u32>,
    pub(super) counts: Vec<u32>,
    pub(super) error_bound: u32,
}

fn matched_words(matched: &[u32]) -> &[u32] {
    match matched.is_empty() {
        true => &NO_MATCHES,
        false => matched,
    }
}

const FACET_MERGE: &str = "a merge of facet lists";

fn input_of<'a>(
    entries: &NumericEntries<'a>,
    matched: &'a [u32],
) -> ffi::narsil_numeric_facet_input {
    ffi::narsil_numeric_facet_input {
        values: entries.values.as_ptr(),
        count: entries.values.len(),
        ordinals: entries.ordinals.as_ptr(),
        ordinal_count: entries.ordinals.len(),
        matched: matched.as_ptr(),
        matched_words: matched.len(),
    }
}

pub(super) fn enum_counts(offsets: &[u32], postings: &[u32], matched: &[u32]) -> Result<Vec<u32>> {
    let matched = matched_words(matched);
    let mut counts = vec![0u32; offsets.len().saturating_sub(1)];
    let status = with_workspace(|workspace| {
        Ok(unsafe {
            ffi::narsil_enum_facet(
                workspace,
                offsets.as_ptr(),
                offsets.len(),
                postings.as_ptr(),
                postings.len(),
                matched.as_ptr(),
                matched.len(),
                counts.as_mut_ptr(),
                counts.len(),
            )
        })
    })?;
    query_accepted("an enum facet count", status)?;
    Ok(counts)
}

pub(super) fn boolean_counts(
    true_bits: &[u32],
    false_bits: &[u32],
    matched: &[u32],
) -> Result<[u32; 2]> {
    let matched = matched_words(matched);
    let index = ffi::narsil_boolean_index {
        true_bits: true_bits.as_ptr(),
        true_words: true_bits.len(),
        false_bits: false_bits.as_ptr(),
        false_words: false_bits.len(),
    };
    let mut counts = [0u32; 2];
    let status = unsafe {
        ffi::narsil_boolean_facet(
            &index,
            matched.as_ptr(),
            matched.len(),
            counts.as_mut_ptr(),
            counts.len(),
        )
    };
    query_accepted("a boolean facet count", status)?;
    Ok(counts)
}

pub(super) fn number_counts(
    entries: &NumericEntries<'_>,
    matched: &[u32],
) -> Result<Vec<(f64, u32)>> {
    let matched = matched_words(matched);
    let input = input_of(entries, matched);
    let mut values = vec![0f64; entries.values.len()];
    let mut counts = vec![0u32; entries.values.len()];
    let output = ffi::narsil_number_facet_output {
        values: values.as_mut_ptr(),
        value_capacity: values.len(),
        counts: counts.as_mut_ptr(),
        count_capacity: counts.len(),
    };
    let mut found = 0u32;
    let status = with_workspace(|workspace| {
        Ok(unsafe { ffi::narsil_number_facet(workspace, &input, &output, &mut found) })
    })?;
    query_accepted("a numeric facet count", status)?;
    let found = found as usize;
    Ok(values.into_iter().zip(counts).take(found).collect())
}

pub(super) fn range_counts(
    entries: &NumericEntries<'_>,
    matched: &[u32],
    ranges: &[f64],
) -> Result<Vec<u32>> {
    let matched = matched_words(matched);
    let input = input_of(entries, matched);
    let mut counts = vec![0u32; ranges.len() / 2];
    let status = with_workspace(|workspace| {
        Ok(unsafe {
            ffi::narsil_range_facet(
                workspace,
                &input,
                ranges.as_ptr(),
                ranges.len(),
                counts.as_mut_ptr(),
                counts.len(),
            )
        })
    })?;
    query_accepted("a numeric range count", status)?;
    Ok(counts)
}

pub(super) fn stored_range_counts(
    stored: &CoreStoredValues,
    matched: &[u32],
    ranges: &[f64],
) -> Result<Vec<u32>> {
    let matched = matched_words(matched);
    let values = stored.view();
    let mut counts = vec![0u32; ranges.len() / 2];
    let status = unsafe {
        ffi::narsil_stored_range_facet(
            &values,
            matched.as_ptr(),
            matched.len(),
            ranges.as_ptr(),
            ranges.len(),
            counts.as_mut_ptr(),
            counts.len(),
        )
    };
    query_accepted("a stored numeric range count", status)?;
    Ok(counts)
}

pub(super) fn value_counts(
    stored: &CoreStoredValues,
    matched: &[u32],
) -> Result<Vec<(usize, u32)>> {
    let matched = matched_words(matched);
    let values = stored.view();
    let mut elements = vec![0u32; stored.element_count()];
    let mut counts = vec![0u32; stored.element_count()];
    let output = ffi::narsil_value_facet_output {
        values: elements.as_mut_ptr(),
        value_capacity: elements.len(),
        counts: counts.as_mut_ptr(),
        count_capacity: counts.len(),
    };
    let mut found = 0u32;
    let status = with_workspace(|workspace| {
        Ok(unsafe {
            ffi::narsil_value_facet(
                workspace,
                &values,
                matched.as_ptr(),
                matched.len(),
                &output,
                &mut found,
            )
        })
    })?;
    query_accepted("a stored value count", status)?;
    let found = found as usize;
    Ok(elements
        .into_iter()
        .map(|element| element as usize)
        .zip(counts)
        .take(found)
        .collect())
}

pub(super) fn merge_facet_lists(
    lists: &FacetLists,
    ascending: bool,
    limit: Option<usize>,
) -> Result<MergedFacet> {
    let distinct = lists.ranks.len();
    let kept = limit.map_or(distinct, |limit| limit.min(distinct));
    let limit = u32::try_from(kept)
        .map_err(|_| query_refused(FACET_MERGE, ffi::NARSIL_INVALID_ARGUMENT))?;
    let request = ffi::narsil_facet_merge_request {
        offsets: lists.offsets.as_ptr(),
        offset_count: lists.offsets.len(),
        values: lists.keys.as_ptr(),
        value_count: lists.keys.len(),
        counts: lists.counts.as_ptr(),
        count_count: lists.counts.len(),
        bounds: lists.bounds.as_ptr(),
        bound_count: lists.bounds.len(),
        ranks: lists.ranks.as_ptr(),
        rank_count: lists.ranks.len(),
        ascending: u32::from(ascending),
        has_limit: 1,
        limit,
    };
    let mut keys = vec![0u32; kept];
    let mut counts = vec![0u32; kept];
    let mut bound = [0u32; 1];
    let mut output = ffi::narsil_facet_merge_output {
        values: keys.as_mut_ptr(),
        value_capacity: keys.len(),
        counts: counts.as_mut_ptr(),
        count_capacity: counts.len(),
        bound: bound.as_mut_ptr(),
        bound_capacity: bound.len(),
        count: 0,
    };
    let status = with_workspace(|workspace| {
        Ok(unsafe { ffi::narsil_merge_facets(workspace, &request, &mut output) })
    })?;
    query_accepted(FACET_MERGE, status)?;
    let found = output.count as usize;
    keys.truncate(found);
    counts.truncate(found);
    Ok(MergedFacet {
        keys,
        counts,
        error_bound: bound[0],
    })
}
