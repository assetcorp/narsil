use std::collections::{BTreeSet, HashSet};

use super::constants::{DEFAULT_FUZZY_PREFIX_LENGTH, DEFAULT_PAGE_SIZE};
use super::coverage::{CoverageRules, filter_by_term_coverage};
use super::groups::{
    ExpansionInputs, PartitionGroups, WordExpansion, plan_word_expansion, resolve_term_groups,
};
use super::params::{QueryParams, TermMatch};
use super::phrases::analyse_query_phrases;
use super::scope::PartitionFilter;
use super::scoring::GlobalStats;
use crate::analysis::{Analyser, TokenOptions};
use crate::config::Bm25Params;
use crate::engine::index::IndexState;
use crate::engine::layout::TextLayout;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::index::partition::PartitionSnapshot;
use crate::search::keyword::{KeywordHit, SegmentInputs, search_partition};
use crate::search::matched::match_partition;
use crate::search::phrase::{AnalysedPhrase, PhraseWork};
use crate::search::query::KeywordQuery;
use crate::search::stats::{candidate_terms, partition_query_stats};
use crate::util::text::javascript_trim;

/// A query's text after analysis: its terms in first-seen order and its distinct phrases, which every partition
/// searches.
pub(crate) struct AnalysedText {
    pub(crate) tokens: Vec<String>,
    pub(crate) phrases: Vec<AnalysedPhrase>,
    pub(crate) expansion: WordExpansion,
}

impl AnalysedText {
    fn phrase_keys(&self) -> Option<HashSet<String>> {
        (!self.phrases.is_empty()).then(|| {
            self.phrases
                .iter()
                .map(|phrase| phrase.key.clone())
                .collect()
        })
    }
}

fn require_search_fields(index: &IndexState, fields: &[String]) -> Result<()> {
    for field in fields {
        let Some(field_type) = index.schema.field_type(field) else {
            return Err(NarsilError::new(
                ErrorCode::SEARCH_INVALID_FIELD,
                format!("Field \"{field}\" does not exist in the schema"),
            ));
        };
        if !field_type.base.is_word_indexed() {
            return Err(NarsilError::new(
                ErrorCode::SEARCH_INVALID_FIELD,
                format!(
                    "Field \"{field}\" has type \"{}\" which cannot be used for full-text search",
                    field_type.name
                ),
            ));
        }
    }
    Ok(())
}

#[derive(Default)]
struct AnalysedWords {
    tokens: Vec<(String, u32)>,
    last: Option<(String, u32)>,
}

fn analysed_words(analyser: &Analyser, text: &str) -> Result<AnalysedWords> {
    let mut tokens: Vec<(String, u32)> = Vec::new();
    let mut last = None;
    analyser.visit_tokens(text, TokenOptions::INDEXING, &mut |term, position, _, _| {
        if !tokens.iter().any(|(held, _)| held == term) {
            tokens.push((term.to_string(), position));
        }
        last = Some((term.to_string(), position));
    })?;
    Ok(AnalysedWords { tokens, last })
}

fn searches_a_partial_field(params: &QueryParams, partial_fields: &[String]) -> bool {
    match &params.fields {
        None => true,
        Some(fields) => fields.iter().any(|field| partial_fields.contains(field)),
    }
}

fn expansion_of(
    index: &IndexState,
    layout: &TextLayout,
    params: &QueryParams,
    words: &str,
    analysed: AnalysedWords,
    ends_with_phrase: bool,
) -> Result<WordExpansion> {
    if analysed.tokens.is_empty() || params.exact == Some(true) {
        return Ok(WordExpansion::default());
    }
    let partial_fields = match params.partial_words == Some(true) {
        true => index.schema.partial_fields(),
        false => Vec::new(),
    };
    let partial_fields = match searches_a_partial_field(params, &partial_fields) {
        true => partial_fields,
        false => Vec::new(),
    };
    let query_tokens: Vec<String> = analysed
        .tokens
        .iter()
        .map(|(token, _)| token.clone())
        .collect();
    let mut expansion = plan_word_expansion(
        &layout.analyser,
        ExpansionInputs {
            words,
            tokens: &analysed.tokens,
            last: analysed.last,
            completes_last_word: params.prefix == Some(true) && !ends_with_phrase,
            partial_fields,
            tolerance: params.tolerance.unwrap_or(0),
            prefix_length: params.prefix_length.unwrap_or(DEFAULT_FUZZY_PREFIX_LENGTH),
        },
    )?;
    if let Some(lookup) = &layout.synonyms.lookup {
        expansion.synonyms = lookup.expand(&query_tokens);
    }
    Ok(expansion)
}

/// Analyses a query's term under the analysis and synonyms of `layout`, the partitions that the query searches, or
/// returns `None` where the query can match nothing.
pub(crate) fn analyse_text(
    index: &IndexState,
    layout: &TextLayout,
    params: &QueryParams,
) -> Result<Option<AnalysedText>> {
    let Some(term) = params
        .term
        .as_deref()
        .filter(|term| !javascript_trim(term).is_empty())
    else {
        return Ok(None);
    };
    if params.fields.as_ref().is_some_and(Vec::is_empty) {
        return Ok(None);
    }
    if let Some(fields) = &params.fields {
        require_search_fields(index, fields)?;
    }
    let quoted = analyse_query_phrases(&layout.analyser, term)?;
    let holds_quotes = quoted.is_some();
    let (words, phrases, ends_with_phrase) = match quoted {
        None => (term.to_string(), Vec::new(), false),
        Some(quoted) => (quoted.words, quoted.phrases, quoted.ends_with_phrase),
    };
    let analysed = match holds_quotes && javascript_trim(&words).is_empty() {
        true => AnalysedWords::default(),
        false => analysed_words(&layout.analyser, &words)?,
    };
    if analysed.tokens.is_empty() && phrases.is_empty() {
        return Ok(None);
    }
    let tokens = analysed
        .tokens
        .iter()
        .map(|(token, _)| token.clone())
        .collect();
    let expansion = expansion_of(index, layout, params, &words, analysed, ends_with_phrase)?;
    Ok(Some(AnalysedText {
        tokens,
        phrases,
        expansion,
    }))
}

/// The settings that a query's full-text search applies in every partition, with the statistics of every partition
/// where the query scores with them.
pub(crate) struct TextSearch<'a> {
    pub(crate) params: &'a QueryParams,
    pub(crate) text: &'a AnalysedText,
    pub(crate) bm25: &'a Bm25Params,
    pub(crate) global: Option<&'a GlobalStats>,
    pub(crate) collect: bool,
    pub(crate) without_hits: bool,
}

impl TextSearch<'_> {
    fn needs_all_results(&self) -> bool {
        let params = self.params;
        params.min_score.is_some()
            || params
                .term_match
                .is_some_and(|policy| policy != TermMatch::Any)
            || params.sort.is_some()
            || params.group.is_some()
            || params.pinned.is_some()
            || params.search_after.is_some()
    }

    fn max_results(&self) -> Option<usize> {
        if self.without_hits {
            return Some(0);
        }
        if self.needs_all_results() {
            return None;
        }
        let limit = self.params.limit.unwrap_or(DEFAULT_PAGE_SIZE);
        let offset = self.params.offset.unwrap_or(0);
        Some(limit.saturating_add(offset).saturating_add(1))
    }
}

/// The hits of one partition's full-text search, with the number of documents that matched.
pub(crate) struct PartitionText {
    pub(crate) hits: Vec<KeywordHit>,
    pub(crate) total_matched: u64,
    pub(crate) matched: Vec<Option<Vec<u32>>>,
}

fn keyword_query<'q>(search: &TextSearch<'q>, resolved: &'q PartitionGroups) -> KeywordQuery<'q> {
    let params = search.params;
    let policy = params.term_match.unwrap_or(TermMatch::Any);
    KeywordQuery {
        tokens: &search.text.tokens,
        groups: &resolved.groups,
        phrases: &search.text.phrases,
        exact: params.exact.unwrap_or(false),
        tolerance: params.tolerance.unwrap_or(0),
        prefix_length: params.prefix_length.unwrap_or(DEFAULT_FUZZY_PREFIX_LENGTH),
        fields: params.fields.as_deref(),
        boost: params.boost.as_deref().unwrap_or(&[]),
        bm25: search.bm25,
        partial_fields: &resolved.partial_fields,
        max_results: search.max_results(),
        collect: search.collect,
        components: params.include_score_components == Some(true) || policy != TermMatch::Any,
    }
}

/// Returns every term that the query reaches in one partition, which the statistics of a `Dfs` query sum across
/// the partitions.
pub(crate) fn partition_terms(
    snapshot: &PartitionSnapshot,
    search: &TextSearch<'_>,
) -> Result<BTreeSet<String>> {
    let resolved = resolve_term_groups(snapshot, &search.text.expansion)?;
    Ok(candidate_terms(snapshot, &keyword_query(search, &resolved)))
}

/// Searches one partition's text, then applies the term match policy and the minimum score. Where `filter` holds
/// the filter's bitset over each segment of the partition, the search scores the documents that it accepts alone.
pub(crate) fn search_partition_text(
    snapshot: &PartitionSnapshot,
    search: &TextSearch<'_>,
    filter: Option<&PartitionFilter>,
    work: &mut dyn PhraseWork,
) -> Result<PartitionText> {
    if filter.is_some_and(PartitionFilter::accepts_nothing) {
        return Ok(PartitionText {
            hits: Vec::new(),
            total_matched: 0,
            matched: Vec::new(),
        });
    }
    let params = search.params;
    let policy = params.term_match.unwrap_or(TermMatch::Any);
    let filters = filter.map(|filter| filter.segments.as_slice());
    let tolerance = params.tolerance.unwrap_or(0);
    let prefix_length = params.prefix_length.unwrap_or(DEFAULT_FUZZY_PREFIX_LENGTH);
    let exact = params.exact.unwrap_or(false);
    let needs_all = search.needs_all_results();
    let resolved = resolve_term_groups(snapshot, &search.text.expansion)?;
    let groups = &resolved.groups;
    let partial_fields = resolved.partial_fields.as_slice();
    let query = keyword_query(search, &resolved);
    if search.without_hits && search.collect && policy == TermMatch::Any {
        return Ok(PartitionText {
            hits: Vec::new(),
            total_matched: 0,
            matched: match_partition(snapshot, &query, filters, work)?,
        });
    }
    let local;
    let stats = match search.global {
        Some(global) => global.stats(),
        None => {
            local = partition_query_stats(snapshot, &query);
            &local
        }
    };
    let inputs = SegmentInputs { filters, work };
    let found = search_partition(snapshot, &query, stats, inputs)?;
    let mut hits = found.hits;
    if policy != TermMatch::Any && !search.text.tokens.is_empty() {
        let phrase_keys = search.text.phrase_keys();
        hits = filter_by_term_coverage(
            hits,
            &CoverageRules {
                tokens: &search.text.tokens,
                policy,
                tolerance,
                prefix_length,
                exact,
                groups,
                partial_fields,
                phrase_keys: phrase_keys.as_ref(),
            },
        );
    }
    if let Some(threshold) = params.min_score.filter(|threshold| *threshold > 0.0) {
        hits.retain(|hit| hit.score >= threshold);
    }
    let total_matched = if needs_all {
        hits.len() as u64
    } else {
        found.total_matched
    };
    Ok(PartitionText {
        hits,
        total_matched,
        matched: found.matched,
    })
}
