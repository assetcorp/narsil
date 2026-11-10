mod field;
mod snippet;

use std::collections::{BTreeMap, HashMap, HashSet};

use super::constants::{
    DEFAULT_FUZZY_PREFIX_LENGTH, DEFAULT_HIGHLIGHT_POST_TAG, DEFAULT_HIGHLIGHT_PRE_TAG,
    DEFAULT_SNIPPET_LENGTH, PARTIAL_WORD_MIN_CODE_POINTS, PARTIAL_WORDS_ADDED_PER_QUERY,
};
use super::params::{HighlightConfig, QueryParams};
use super::phrases::analyse_query_phrases;
use super::projection::{Projection, projection_keeps_field};
use super::results::Hit;
use crate::analysis::{Analyser, ResolvedAnalysis, TokenOptions};
use crate::engine::index::IndexState;
use crate::engine::layout::TextLayout;
use crate::error::Result;
use crate::util::text::javascript_trim;
use crate::value::{Map, Value};

struct PartialTagging {
    fields: HashSet<String>,
    words: Vec<String>,
}

struct Highlighter {
    index_analyser: Analyser,
    field_analyser: Analyser,
    stemmed_query: Vec<(String, u32)>,
    prefix_length: u32,
    prefix_token: Option<String>,
    synonyms: HashSet<String>,
    partial: Option<PartialTagging>,
    pre_tag: Vec<u16>,
    post_tag: Vec<u16>,
    max_length: usize,
    verdicts: HashMap<String, bool>,
}

fn positioned_words(analyser: &Analyser, text: &str, stem: bool) -> Result<Vec<(String, u32)>> {
    let options = TokenOptions {
        stem,
        remove_stop_words: true,
        remove_diacritics: false,
        collect_surfaces: false,
    };
    let mut words = Vec::new();
    analyser.visit_tokens(text, options, &mut |term, position, _, _| {
        words.push((term.to_string(), position));
    })?;
    Ok(words)
}

fn partial_words_to_highlight(
    query_tokens: &[(String, u32)],
    written: &[(String, u32)],
) -> Vec<String> {
    let mut written_at: HashMap<u32, &str> = HashMap::new();
    for (word, position) in written {
        written_at.entry(*position).or_insert(word);
    }
    let mut seen: HashSet<&str> = HashSet::new();
    let mut words = Vec::new();
    for (token, position) in query_tokens {
        if !seen.insert(token) {
            continue;
        }
        let Some(word) = written_at.get(position) else {
            continue;
        };
        if word.chars().count() < PARTIAL_WORD_MIN_CODE_POINTS {
            continue;
        }
        words.push(word.to_string());
        if words.len() == PARTIAL_WORDS_ADDED_PER_QUERY {
            break;
        }
    }
    words
}

fn partial_tagging(
    index: &IndexState,
    params: &QueryParams,
    query_tokens: &[(String, u32)],
    written: &[(String, u32)],
) -> Option<PartialTagging> {
    let fields: HashSet<String> = index
        .schema
        .partial_fields()
        .into_iter()
        .filter(|field| {
            params
                .fields
                .as_ref()
                .is_none_or(|searched| searched.contains(field))
        })
        .collect();
    if fields.is_empty() {
        return None;
    }
    let words = partial_words_to_highlight(query_tokens, written);
    (!words.is_empty()).then_some(PartialTagging { fields, words })
}

fn synonyms_of(layout: &TextLayout, query_tokens: &[(String, u32)]) -> HashSet<String> {
    let mut synonyms = HashSet::new();
    let Some(lookup) = &layout.synonyms.lookup else {
        return synonyms;
    };
    let tokens: Vec<String> = query_tokens
        .iter()
        .map(|(token, _)| token.clone())
        .collect();
    for (_, added) in lookup.expand(&tokens) {
        synonyms.extend(added);
    }
    synonyms
}

impl Highlighter {
    fn new(
        index: &IndexState,
        layout: &TextLayout,
        params: &QueryParams,
        config: &HighlightConfig,
    ) -> Result<Highlighter> {
        let analyser = &layout.analyser;
        let term = params.term.as_deref().unwrap_or("");
        let quoted = analyse_query_phrases(analyser, term)?;
        let wants_prefix = params.prefix == Some(true);
        let (words, prefix, phrase_tokens) = match &quoted {
            None => (term, wants_prefix, Vec::new()),
            Some(quoted) => (
                quoted.words.as_str(),
                wants_prefix && !quoted.ends_with_phrase,
                quoted
                    .phrases
                    .iter()
                    .flat_map(|phrase| phrase.tokens.iter().cloned())
                    .collect(),
            ),
        };
        let exact = params.exact == Some(true);
        let query_tokens = match quoted.is_some() && javascript_trim(words).is_empty() {
            true => Vec::new(),
            false => positioned_words(analyser, words, true)?,
        };
        let uses_prefix = prefix && !exact && !query_tokens.is_empty();
        let uses_partial_words =
            params.partial_words == Some(true) && !exact && !query_tokens.is_empty();
        let written = match uses_prefix || uses_partial_words {
            true => positioned_words(analyser, words, false)?,
            false => Vec::new(),
        };
        let completion =
            query_tokens
                .last()
                .filter(|_| uses_prefix)
                .and_then(|(last, position)| {
                    written
                        .iter()
                        .find(|(_, at)| at == position)
                        .map(|(word, _)| (word.clone(), last.clone()))
                });
        let partial = match uses_partial_words {
            true => partial_tagging(index, params, &query_tokens, &written),
            false => None,
        };
        let mut synonyms = match exact || query_tokens.is_empty() {
            true => HashSet::new(),
            false => synonyms_of(layout, &query_tokens),
        };
        synonyms.extend(phrase_tokens);
        let field_analyser =
            Analyser::new(analyser.language().clone(), &ResolvedAnalysis::default())?;
        let tolerance = match exact {
            true => 0,
            false => params.tolerance.unwrap_or(0),
        };
        let mut stemmed_query = Vec::with_capacity(query_tokens.len());
        for (token, _) in &query_tokens {
            let completed = completion
                .as_ref()
                .is_some_and(|(_, completed)| completed == token);
            let stemmed = field_analyser.transform(&token.to_lowercase(), true, false)?;
            stemmed_query.push((stemmed, if completed { 0 } else { tolerance }));
        }
        Ok(Highlighter {
            index_analyser: analyser.clone(),
            field_analyser,
            stemmed_query,
            prefix_length: params.prefix_length.unwrap_or(DEFAULT_FUZZY_PREFIX_LENGTH),
            prefix_token: completion.map(|(word, _)| word),
            synonyms,
            partial,
            pre_tag: config
                .pre_tag
                .as_deref()
                .unwrap_or(DEFAULT_HIGHLIGHT_PRE_TAG)
                .encode_utf16()
                .collect(),
            post_tag: config
                .post_tag
                .as_deref()
                .unwrap_or(DEFAULT_HIGHLIGHT_POST_TAG)
                .encode_utf16()
                .collect(),
            max_length: config.max_snippet_length.unwrap_or(DEFAULT_SNIPPET_LENGTH),
            verdicts: HashMap::new(),
        })
    }
}

fn text_field<'d>(document: &'d Map, field: &str) -> Option<&'d str> {
    match document.get(field) {
        Some(Value::String(text)) => Some(text),
        _ => None,
    }
}

pub(crate) fn highlight_hits(
    index: &IndexState,
    layout: &TextLayout,
    params: &QueryParams,
    hits: &mut [Hit],
    projection: &Projection,
) -> Result<()> {
    let Some(config) = params.highlight.as_ref() else {
        return Ok(());
    };
    let mut highlighter = Highlighter::new(index, layout, params, config)?;
    let reads_stored = config
        .fields
        .iter()
        .any(|field| !projection_keeps_field(projection, field));
    for hit in hits.iter_mut() {
        let mut highlights = BTreeMap::new();
        let mut stored: Option<Option<Map>> = None;
        for field in &config.fields {
            let found = match text_field(&hit.document, field) {
                Some(text) => Some(highlighter.highlight_field(text, field)?),
                None if reads_stored => {
                    if stored.is_none() {
                        stored = Some(index.full_document(&layout.partitions, &hit.id)?);
                    }
                    match stored
                        .as_ref()
                        .and_then(Option::as_ref)
                        .and_then(|document| text_field(document, field))
                    {
                        Some(text) => Some(highlighter.highlight_field(text, field)?),
                        None => None,
                    }
                }
                None => None,
            };
            if let Some(found) = found {
                highlights.insert(field.clone(), found);
            }
        }
        hit.highlights = Some(highlights);
    }
    Ok(())
}
