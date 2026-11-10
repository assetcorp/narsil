use std::collections::HashSet;

use crate::error::Result;

use super::super::core::with_scratch;
use super::super::field::Generation;
use super::super::filter::OrdinalFilter;
use super::super::ranking::merge_results;
use super::super::search::{Scan, VectorSearchOptions, VectorSearchOutcome, scan};
use super::ColdHold;
use super::field::ColdField;
use super::scan::{FileScan, scan_numbers};
use super::walk::{GraphWalk, walk_graph};

pub(crate) struct ColdQuery<'a> {
    pub(crate) query: &'a [f32],
    pub(crate) k: usize,
    pub(crate) options: &'a VectorSearchOptions,
    pub(crate) matching: Option<&'a [&'a str]>,
    pub(crate) pin: i64,
    pub(crate) filter_threshold: f64,
}

struct Admitted {
    numbers: Vec<u32>,
    held: OrdinalFilter,
}

impl Admitted {
    fn count(&self) -> u64 {
        self.numbers.len() as u64 + self.held.count()
    }
}

fn exact(matched: u64) -> VectorSearchOutcome {
    VectorSearchOutcome {
        results: Vec::new(),
        matched,
        matched_exact: true,
    }
}

fn numbers_of(field: &ColdField, matching: &[&str], excluded: &[u32]) -> Result<Vec<u32>> {
    let total = field.total();
    let visible = |number: u32| excluded.binary_search(&number).is_err();
    let reads_per_lookup = field.files().len() as u64 * u64::from(total.max(1).ilog2() + 1);
    let mut numbers = Vec::new();
    if (matching.len() as u64).saturating_mul(reads_per_lookup) < u64::from(total) {
        for doc_id in matching {
            if let Some(number) = field.number_of(doc_id)?
                && visible(number)
            {
                numbers.push(number);
            }
        }
        numbers.sort_unstable();
        numbers.dedup();
        return Ok(numbers);
    }
    let wanted: HashSet<&str> = matching.iter().copied().collect();
    for number in 0..total {
        if !field.is_dead_number(number)
            && visible(number)
            && wanted.contains(field.id_at(number)?.as_str())
        {
            numbers.push(number);
        }
    }
    Ok(numbers)
}

fn scan_held(
    held: &Generation,
    request: &ColdQuery<'_>,
    filter: Option<&OrdinalFilter>,
) -> Result<(Vec<super::super::ranking::VectorHit>, u64)> {
    if held.store.slots() == 0 {
        return Ok((Vec::new(), 0));
    }
    let written = Scan {
        generation: held,
        query: request.query,
        k: request.k,
        options: request.options,
        pin: request.pin,
    };
    with_scratch(|scratch| match filter {
        Some(found) => scan(scratch, &written, found.ordinals().iter().copied()),
        None => scan(scratch, &written, 0..held.store.slots()),
    })
}

fn scan_admitted(
    field: &ColdField,
    held: &Generation,
    request: &ColdQuery<'_>,
    admitted: &Admitted,
) -> Result<VectorSearchOutcome> {
    let in_files = FileScan {
        field,
        query: request.query,
        options: request.options,
        k: request.k,
    };
    let (from_files, matched_in_files) =
        with_scratch(|scratch| scan_numbers(scratch, &in_files, &admitted.numbers))?;
    let (from_held, matched_in_held) = scan_held(held, request, Some(&admitted.held))?;
    Ok(VectorSearchOutcome {
        results: merge_results(from_files, from_held, request.k),
        matched: matched_in_files + matched_in_held,
        matched_exact: true,
    })
}

pub(crate) fn search_cold(hold: &ColdHold, request: &ColdQuery<'_>) -> Result<VectorSearchOutcome> {
    let view = hold.view(request.pin);
    if view.live == 0 {
        return Ok(exact(0));
    }
    let field = &hold.field;
    let held = hold.held_field().shared.current();
    let admitted = match request.matching {
        None => None,
        Some(doc_ids) => Some(Admitted {
            numbers: numbers_of(field, doc_ids, &view.excluded)?,
            held: held.filter_of(doc_ids.iter().copied(), request.pin),
        }),
    };
    let admitted_count = admitted.as_ref().map_or(view.live, Admitted::count);
    if let Some(found) = &admitted {
        if admitted_count == 0 {
            return Ok(exact(0));
        }
        if (admitted_count as f64 / view.live as f64) < request.filter_threshold {
            return scan_admitted(field, &held, request, found);
        }
    }
    let counts_every_admitted = request.options.min_similarity == f64::NEG_INFINITY;
    if request.k == 0 {
        return Ok(VectorSearchOutcome {
            results: Vec::new(),
            matched: if counts_every_admitted {
                admitted_count
            } else {
                0
            },
            matched_exact: counts_every_admitted,
        });
    }
    let from_graph = walk_graph(&GraphWalk {
        field,
        query: request.query,
        options: request.options,
        k: request.k,
        accepted: admitted.as_ref().map(|found| found.numbers.as_slice()),
        excluded: &view.excluded,
    })?;
    let (from_held, _) = scan_held(&held, request, admitted.as_ref().map(|found| &found.held))?;
    let results = merge_results(from_graph, from_held, request.k);
    Ok(VectorSearchOutcome {
        matched: if counts_every_admitted {
            admitted_count
        } else {
            results.len() as u64
        },
        results,
        matched_exact: counts_every_admitted,
    })
}
