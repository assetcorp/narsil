use std::cmp::Ordering;

use super::doc_ids::OrdinalNames;

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct VectorHit {
    pub(crate) doc_id: String,
    pub(crate) score: f64,
    pub(crate) ordinal: u32,
}

fn ordered_score(score: f64) -> f64 {
    if score.is_nan() {
        f64::NEG_INFINITY
    } else {
        score
    }
}

pub(crate) fn best_first(left: (f64, &str), right: (f64, &str)) -> Ordering {
    ordered_score(right.0)
        .total_cmp(&ordered_score(left.0))
        .then_with(|| left.1.cmp(right.1))
}

pub(crate) struct Ranked<'n> {
    names: &'n OrdinalNames,
    k: usize,
    held: Vec<(f64, u32)>,
    pub(crate) matched: u64,
}

impl<'n> Ranked<'n> {
    pub(crate) fn new(names: &'n OrdinalNames, k: usize) -> Ranked<'n> {
        Ranked {
            names,
            k,
            held: Vec::with_capacity(k.saturating_mul(2).min(4_096)),
            matched: 0,
        }
    }

    fn name(&self, ordinal: u32) -> &'n str {
        self.names.get(ordinal).unwrap_or("")
    }

    fn compare(&self, left: &(f64, u32), right: &(f64, u32)) -> Ordering {
        best_first((left.0, self.name(left.1)), (right.0, self.name(right.1)))
    }

    pub(crate) fn admit(&mut self, score: f64, ordinal: u32) {
        self.matched += 1;
        if self.k == 0 {
            return;
        }
        self.held.push((score, ordinal));
        if self.held.len() >= self.k.saturating_mul(2).max(64) {
            self.shrink();
        }
    }

    fn shrink(&mut self) {
        if self.held.len() <= self.k {
            return;
        }
        let names = self.names;
        let compare = |left: &(f64, u32), right: &(f64, u32)| {
            best_first(
                (left.0, names.get(left.1).unwrap_or("")),
                (right.0, names.get(right.1).unwrap_or("")),
            )
        };
        self.held.select_nth_unstable_by(self.k - 1, compare);
        self.held.truncate(self.k);
    }

    pub(crate) fn finish(mut self) -> Vec<VectorHit> {
        self.shrink();
        let mut held = std::mem::take(&mut self.held);
        held.sort_by(|left, right| self.compare(left, right));
        held.into_iter()
            .filter_map(|(score, ordinal)| {
                self.names.get(ordinal).map(|doc_id| VectorHit {
                    doc_id: doc_id.to_string(),
                    score,
                    ordinal,
                })
            })
            .collect()
    }
}

pub(crate) fn merge_results(
    graph: Vec<VectorHit>,
    buffer: Vec<VectorHit>,
    k: usize,
) -> Vec<VectorHit> {
    let mut seen = std::collections::HashSet::new();
    let mut merged = Vec::with_capacity(k.min(graph.len() + buffer.len()));
    let mut graph = graph.into_iter().peekable();
    let mut buffer = buffer.into_iter().peekable();
    while merged.len() < k {
        let take_graph = match (graph.peek(), buffer.peek()) {
            (Some(left), Some(right)) => {
                left.score > right.score
                    || (left.score == right.score && left.doc_id < right.doc_id)
            }
            (Some(_), None) => true,
            (None, Some(_)) => false,
            (None, None) => break,
        };
        let pick = if take_graph {
            graph.next()
        } else {
            buffer.next()
        };
        let Some(pick) = pick else {
            break;
        };
        if seen.insert(pick.doc_id.clone()) {
            merged.push(pick);
        }
    }
    merged
}
