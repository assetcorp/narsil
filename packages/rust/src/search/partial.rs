use std::collections::HashMap;

use super::fuzzy::fuzzy_term_matches;
use super::words::partition_document_frequency;
use crate::index::partition::PartitionSnapshot;
use crate::index::spellings::SpellingEntry;

/// One query word that a partial-word search looks for inside the longer words of the documents.
pub(crate) struct PartialWordRequest {
    pub(crate) token: String,
    pub(crate) written: String,
    pub(crate) share: usize,
    pub(crate) tolerance: u32,
    pub(crate) prefix_length: u32,
}

impl PartialWordRequest {
    fn excludes(&self, token: &str) -> bool {
        token == self.token
            || (self.tolerance > 0
                && fuzzy_term_matches(&self.token, token, self.tolerance, self.prefix_length))
    }
}

/// Returns up to `request.share` index tokens whose spellings in the partition's live documents contain the word
/// that the query wrote, most frequent first and then in code point order, each with the share of its shortest
/// spelling that the written word covers.
pub(crate) fn expand_partial_word(
    snapshot: &PartitionSnapshot,
    request: &PartialWordRequest,
) -> Vec<(String, f64)> {
    if request.share == 0 {
        return Vec::new();
    }
    let mut shortest: HashMap<String, usize> = HashMap::new();
    for entry in &snapshot.segments {
        let removed = &entry.removed_words;
        let live = |spelling: &SpellingEntry| {
            removed.spelling_count(&spelling.spelling, &spelling.token, spelling.count) > 0
        };
        entry
            .stored_spellings()
            .visit_containing(&request.written, &live, &mut |spelling| match shortest
                .get_mut(&spelling.token)
            {
                Some(length) => *length = (*length).min(spelling.length),
                None => {
                    shortest.insert(spelling.token.clone(), spelling.length);
                }
            });
    }
    let mut ranked: Vec<(u64, String, usize)> = shortest
        .into_iter()
        .filter(|(token, _)| !request.excludes(token))
        .filter_map(|(token, length)| {
            let documents = partition_document_frequency(snapshot, &token);
            (documents > 0).then_some((documents, token, length))
        })
        .collect();
    ranked.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1)));
    ranked.truncate(request.share);
    let written_length = request.written.chars().count() as f64;
    ranked
        .into_iter()
        .map(|(_, token, length)| (token, written_length / length as f64))
        .collect()
}
