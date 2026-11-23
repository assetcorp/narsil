mod native;
mod segment;

use std::borrow::Cow;
use std::collections::HashMap;

use super::params::{FacetSpec, QueryParams, SortDirection};
use super::results::FacetResult;
use super::validate::distinct_facet_fields;
use crate::engine::index::IndexState;
use crate::error::Result;
use crate::index::segment::SegmentEntry;
use crate::schema::BaseType;
use crate::value::number_to_text;
use native::{FacetLists, merge_facet_lists};
use segment::{segment_buckets, segment_ranges};

pub(crate) struct MatchedSegment<'a> {
    pub(crate) partition: u32,
    pub(crate) segment: u32,
    pub(crate) entry: &'a SegmentEntry,
    pub(crate) words: Cow<'a, [u32]>,
}

#[derive(Default)]
struct BucketLists {
    labels: Vec<String>,
    places: HashMap<String, u32>,
    offsets: Vec<u32>,
    keys: Vec<u32>,
    counts: Vec<u32>,
}

impl BucketLists {
    fn add(&mut self, buckets: impl IntoIterator<Item = (String, u32)>) {
        if self.offsets.is_empty() {
            self.offsets.push(0);
        }
        for (label, count) in buckets {
            let key = match self.places.get(&label) {
                Some(&key) => key,
                None => {
                    let key = self.labels.len() as u32;
                    self.places.insert(label.clone(), key);
                    self.labels.push(label);
                    key
                }
            };
            self.keys.push(key);
            self.counts.push(count);
        }
        self.offsets.push(self.keys.len() as u32);
    }

    fn merged(mut self, spec: &FacetSpec) -> Result<FacetResult> {
        if self.offsets.is_empty() {
            self.offsets.push(0);
        }
        let mut ordered: Vec<u32> = (0..self.labels.len() as u32).collect();
        ordered
            .sort_by(|left, right| self.labels[*left as usize].cmp(&self.labels[*right as usize]));
        let mut ranks = vec![0u32; self.labels.len()];
        for (rank, key) in ordered.into_iter().enumerate() {
            ranks[key as usize] = rank as u32;
        }
        let lists = FacetLists {
            bounds: vec![0; self.offsets.len() - 1],
            offsets: self.offsets,
            keys: self.keys,
            counts: self.counts,
            ranks,
        };
        let merged = merge_facet_lists(
            &lists,
            spec.sort == Some(SortDirection::Asc),
            kept_values(spec.limit),
        )?;
        let values: Vec<(String, u64)> = merged
            .keys
            .iter()
            .zip(&merged.counts)
            .map(|(key, count)| (self.labels[*key as usize].clone(), u64::from(*count)))
            .collect();
        Ok(FacetResult {
            count: values.len(),
            values,
            error_bound: u64::from(merged.error_bound),
        })
    }
}

fn kept_values(limit: Option<usize>) -> Option<usize> {
    limit.filter(|limit| *limit > 0)
}

fn spec_of<'p>(params: &'p QueryParams, field: &str) -> Option<&'p FacetSpec> {
    params
        .facets
        .as_deref()?
        .iter()
        .rev()
        .find(|(held, _)| held == field)
        .map(|(_, spec)| spec)
}

fn range_label(from: f64, to: f64) -> String {
    format!("{}-{}", number_to_text(from), number_to_text(to))
}

fn range_lists(
    field: &str,
    base: Option<BaseType>,
    ranges: &[(f64, f64)],
    matched: &[MatchedSegment<'_>],
) -> Result<BucketLists> {
    let bounds: Vec<f64> = ranges.iter().flat_map(|(from, to)| [*from, *to]).collect();
    let mut lists = BucketLists::default();
    let mut counted = false;
    for segment in matched {
        let counts = segment_ranges(segment, field, base, &bounds)?;
        lists.add(labelled_ranges(ranges, &counts));
        counted = true;
    }
    if !counted {
        lists.add(labelled_ranges(ranges, &vec![0; ranges.len()]));
    }
    Ok(lists)
}

fn labelled_ranges(ranges: &[(f64, f64)], counts: &[u32]) -> Vec<(String, u32)> {
    let mut labelled: Vec<(String, u32)> = Vec::with_capacity(ranges.len());
    for ((from, to), count) in ranges.iter().zip(counts) {
        let label = range_label(*from, *to);
        match labelled.iter_mut().find(|(held, _)| *held == label) {
            Some(held) => held.1 = *count,
            None => labelled.push((label, *count)),
        }
    }
    labelled
}

pub(crate) fn count_facets(
    index: &IndexState,
    params: &QueryParams,
    matched: &[MatchedSegment<'_>],
) -> Result<Vec<(String, FacetResult)>> {
    let fields = distinct_facet_fields(params);
    let mut results = Vec::with_capacity(fields.len());
    for field in fields {
        let Some(spec) = spec_of(params, field) else {
            continue;
        };
        let base = index
            .schema
            .field_type(field)
            .map(|field_type| field_type.base);
        let numeric = matches!(base, None | Some(BaseType::Number | BaseType::NumberList));
        let lists = match spec.ranges.as_deref() {
            Some(ranges) if numeric => range_lists(field, base, ranges, matched)?,
            _ => {
                let mut lists = BucketLists::default();
                for segment in matched {
                    lists.add(segment_buckets(segment, field, base)?);
                }
                lists
            }
        };
        results.push((field.to_string(), lists.merged(spec)?));
    }
    Ok(results)
}

pub(crate) struct MergedBuckets {
    pub(crate) buckets: Vec<(String, u32)>,
    pub(crate) error_bound: u32,
}

pub(crate) fn merge_bucket_lists(
    lists: &[Vec<(String, u32)>],
    bounds: &[u32],
    ascending: bool,
    limit: Option<usize>,
) -> Result<MergedBuckets> {
    let mut buckets = BucketLists::default();
    for list in lists {
        buckets.add(list.iter().cloned());
    }
    if buckets.offsets.is_empty() {
        buckets.offsets.push(0);
    }
    let mut ordered: Vec<u32> = (0..buckets.labels.len() as u32).collect();
    ordered.sort_by(|left, right| {
        buckets.labels[*left as usize].cmp(&buckets.labels[*right as usize])
    });
    let mut ranks = vec![0u32; buckets.labels.len()];
    for (rank, key) in ordered.into_iter().enumerate() {
        ranks[key as usize] = rank as u32;
    }
    let merged = merge_facet_lists(
        &FacetLists {
            offsets: buckets.offsets,
            keys: buckets.keys,
            counts: buckets.counts,
            bounds: bounds.to_vec(),
            ranks,
        },
        ascending,
        limit,
    )?;
    Ok(MergedBuckets {
        buckets: merged
            .keys
            .iter()
            .zip(&merged.counts)
            .map(|(key, count)| (buckets.labels[*key as usize].clone(), *count))
            .collect(),
        error_bound: merged.error_bound,
    })
}
