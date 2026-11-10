use std::collections::HashMap;
use std::time::{Duration, Instant};

use super::Narsil;
use super::constants::{
    DEFAULT_SUGGEST_LIMIT, MAX_SUGGEST_LIMIT, MIN_SUGGEST_LIMIT, SUGGEST_PARTITION_OVERSAMPLE,
};
use super::index::IndexState;
use crate::analysis::{Analyser, ResolvedAnalysis, TokenOptions};
use crate::error::Result;
use crate::index::partition::PartitionSnapshot;
use crate::keyword::expansion::ExpansionSources;
use crate::util::text::javascript_trim;

const UNSTEMMED_PREFIX: TokenOptions = TokenOptions {
    stem: false,
    remove_stop_words: false,
    remove_diacritics: false,
    collect_surfaces: false,
};

/// Everything that [`Narsil::suggest`] accepts.
#[derive(Debug, Clone, Default)]
pub struct SuggestParams {
    /// What the caller has typed so far; the engine completes its last word.
    pub prefix: String,
    /// The number of terms to return, 10 by default; the engine raises 0 to 1 and lowers anything above 100 to 100.
    pub limit: Option<usize>,
}

/// One completion of [`Narsil::suggest`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SuggestedTerm {
    /// The completed word: the form that the documents write most often where the index keeps surface forms, and
    /// the indexed stem otherwise.
    pub term: String,
    /// The number of live documents that hold the word.
    pub document_frequency: u64,
}

/// The completions of [`Narsil::suggest`].
#[derive(Debug, Clone, PartialEq)]
pub struct SuggestResult {
    /// The completions, the word that the most documents hold first, then in code point order.
    pub terms: Vec<SuggestedTerm>,
    /// The time that the engine spent finding the completions.
    pub elapsed: Duration,
    /// Whether the index's terms came from an older analysis than its language produces now, so that the
    /// completions can differ from what a rebuilt index would return.
    pub analysis_stale: bool,
}

#[derive(Default)]
struct TokenGroup {
    document_frequency: u64,
    surfaces: Vec<(String, u64)>,
}

impl TokenGroup {
    fn add_surface(&mut self, surface: &str, occurrences: u64) {
        match self.surfaces.iter_mut().find(|(held, _)| held == surface) {
            Some((_, total)) => *total = total.saturating_add(occurrences),
            None => self.surfaces.push((surface.to_string(), occurrences)),
        }
    }

    fn absorb(&mut self, other: TokenGroup) {
        self.document_frequency = self
            .document_frequency
            .saturating_add(other.document_frequency);
        for (surface, occurrences) in other.surfaces {
            self.add_surface(&surface, occurrences);
        }
    }

    fn display_surface(&self) -> &str {
        let mut best: Option<&(String, u64)> = None;
        for candidate in &self.surfaces {
            let better = match best {
                None => true,
                Some((surface, occurrences)) => {
                    candidate.1 > *occurrences
                        || (candidate.1 == *occurrences && candidate.0 < *surface)
                }
            };
            if better {
                best = Some(candidate);
            }
        }
        best.map_or("", |(surface, _)| surface.as_str())
    }
}

/// Token groups in the order that each token first arrived, so that a tie in the final order keeps the order in
/// which the reference engine meets its tokens.
#[derive(Default)]
struct GroupList {
    at: HashMap<String, usize>,
    groups: Vec<(String, TokenGroup)>,
}

impl GroupList {
    fn group(&mut self, token: &str) -> &mut TokenGroup {
        let at = match self.at.get(token) {
            Some(at) => *at,
            None => {
                self.at.insert(token.to_string(), self.groups.len());
                self.groups.push((token.to_string(), TokenGroup::default()));
                self.groups.len() - 1
            }
        };
        &mut self.groups[at].1
    }

    fn absorb(&mut self, token: String, group: TokenGroup) {
        self.group(&token).absorb(group);
    }
}

fn partition_suggestions(
    snapshot: &PartitionSnapshot,
    surface_prefix: &str,
    stemmed_prefix: &str,
    limit: usize,
) -> Result<Vec<(String, TokenGroup)>> {
    let limit = u32::try_from(limit).unwrap_or(u32::MAX);
    let suggestions =
        ExpansionSources::of(snapshot)?.suggest(surface_prefix, stemmed_prefix, limit)?;
    Ok(suggestions
        .into_iter()
        .map(|suggestion| {
            let group = TokenGroup {
                document_frequency: u64::from(suggestion.document_frequency),
                surfaces: suggestion
                    .spellings
                    .into_iter()
                    .map(|(spelling, occurrences)| (spelling, occurrences as u64))
                    .collect(),
            };
            (suggestion.token, group)
        })
        .collect())
}

fn suggestion_limit(limit: Option<usize>) -> usize {
    limit
        .unwrap_or(DEFAULT_SUGGEST_LIMIT)
        .clamp(MIN_SUGGEST_LIMIT, MAX_SUGGEST_LIMIT)
}

fn completed_word(analyser: &Analyser, prefix: &str) -> Result<Option<(String, String)>> {
    let builtin = Analyser::new(analyser.language().clone(), &ResolvedAnalysis::default())?;
    let mut last: Option<String> = None;
    builtin.visit_tokens(prefix, UNSTEMMED_PREFIX, &mut |term, _, _, _| {
        last = Some(term.to_string());
    })?;
    let word = last.unwrap_or_else(|| prefix.to_lowercase());
    if word.is_empty() {
        return Ok(None);
    }
    let stemmed = builtin.transform(&word, true, false)?;
    Ok(Some((word, stemmed)))
}

fn suggested_terms(index: &IndexState, params: &SuggestParams) -> Result<Vec<SuggestedTerm>> {
    let limit = suggestion_limit(params.limit);
    let prefix = javascript_trim(&params.prefix);
    if prefix.is_empty() {
        return Ok(Vec::new());
    }
    let layout = index.partitions();
    let Some((word, stemmed)) = completed_word(&layout.analyser, prefix)? else {
        return Ok(Vec::new());
    };
    let per_partition = limit.saturating_mul(SUGGEST_PARTITION_OVERSAMPLE);
    let mut merged = GroupList::default();
    for partition in layout.iter() {
        let snapshot = partition.snapshot();
        for (token, group) in partition_suggestions(&snapshot, &word, &stemmed, per_partition)? {
            merged.absorb(token, group);
        }
    }
    let mut terms: Vec<SuggestedTerm> = merged
        .groups
        .iter()
        .map(|(_, group)| SuggestedTerm {
            term: group.display_surface().to_string(),
            document_frequency: group.document_frequency,
        })
        .collect();
    terms.sort_by(|left, right| {
        right
            .document_frequency
            .cmp(&left.document_frequency)
            .then_with(|| left.term.cmp(&right.term))
    });
    terms.truncate(limit);
    Ok(terms)
}

impl Narsil {
    /// Returns completions of the last word of `params.prefix`, the word that the most live documents hold first,
    /// which is what an autocomplete box shows under a search field.
    ///
    /// The engine reads the prefix with the language's built-in tokeniser, even where the index sets a custom one,
    /// and matches both the word as typed and its stem. Each completion is the form that the documents write most
    /// often where the index keeps surface forms, and the indexed stem otherwise. A prefix of white space alone
    /// returns no completion. Fails with `INDEX_NOT_FOUND` where the engine holds no index called `index`.
    pub fn suggest(&self, index: &str, params: &SuggestParams) -> Result<SuggestResult> {
        let started = Instant::now();
        let index = self.inner.open_index(index)?;
        let terms = suggested_terms(&index, params)?;
        Ok(SuggestResult {
            terms,
            elapsed: started.elapsed(),
            analysis_stale: index.analysis_stale(),
        })
    }
}
