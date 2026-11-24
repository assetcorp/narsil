use std::collections::HashMap;

use crate::analysis::Language;
use crate::error::Result;
use crate::keyword::expansion::{ExpansionSources, FoldedWordRequest, PartialWordRequest};
use crate::search::phrase::AnalysedPhrase;
use crate::search::query::{FoldedQueryTerm, TermGroup};

/// The folds and keys of a query's words, which folded matching widens in every partition of an index that folds.
pub(crate) struct FoldedWords {
    pub(crate) language: u32,
    pub(crate) keys: Vec<(String, String)>,
    pub(crate) tolerance: u32,
    pub(crate) prefix_length: u32,
    pub(crate) prefix_fold: Option<String>,
    pub(crate) partial_folds: Vec<String>,
    pub(crate) phrase_keys: Vec<Vec<String>>,
}

/// What [`plan_folding`] folds: the query's tokens with their positions, each token's word as written, the last
/// word that a prefix search completes, the words that partial-word search looks for, and the query's phrases.
pub(crate) struct FoldingInputs<'a> {
    pub(crate) tokens: &'a [(String, u32)],
    pub(crate) written: &'a HashMap<u32, String>,
    pub(crate) prefix_written: Option<&'a str>,
    pub(crate) partial: &'a [PartialWordRequest],
    pub(crate) phrases: &'a [AnalysedPhrase],
    pub(crate) tolerance: u32,
    pub(crate) prefix_length: u32,
}

/// Computes once per query the key of each term and each phrase word, and the fold of the words that a prefix
/// search and a partial-word search widen.
pub(crate) fn plan_folding(language: &Language, inputs: FoldingInputs<'_>) -> Result<FoldedWords> {
    let mut keys = Vec::with_capacity(inputs.tokens.len());
    for (token, position) in inputs.tokens {
        let written = inputs.written.get(position).unwrap_or(token);
        keys.push((token.clone(), language.fold_spelling(written, true)?));
    }
    let prefix_fold = inputs
        .prefix_written
        .map(|written| language.fold_spelling(written, false))
        .transpose()?;
    let partial_folds = inputs
        .partial
        .iter()
        .map(|request| language.fold_spelling(&request.written, false))
        .collect::<Result<Vec<_>>>()?;
    let mut phrase_keys = Vec::with_capacity(inputs.phrases.len());
    for phrase in inputs.phrases {
        let mut keys_of_phrase = Vec::with_capacity(phrase.tokens.len());
        for (at, token) in phrase.tokens.iter().enumerate() {
            let written = phrase.written.get(at).unwrap_or(token);
            keys_of_phrase.push(language.fold_spelling(written, true)?);
        }
        phrase_keys.push(keys_of_phrase);
    }
    Ok(FoldedWords {
        language: language.core_index(),
        keys,
        tolerance: inputs.tolerance,
        prefix_length: inputs.prefix_length,
        prefix_fold,
        partial_folds,
        phrase_keys,
    })
}

/// The folded terms of one partition and, where the query holds phrases, its phrases with the variants of each
/// position.
pub(crate) struct ResolvedFolding {
    pub(crate) folded: Vec<FoldedQueryTerm>,
    pub(crate) phrases: Option<Vec<AnalysedPhrase>>,
}

fn word_request(
    folding: &FoldedWords,
    groups: &[TermGroup],
    token: &str,
    key: &str,
) -> FoldedWordRequest {
    let group = groups.iter().find(|group| group.token == token);
    FoldedWordRequest {
        key: key.to_string(),
        own: token.to_string(),
        excluded: group
            .and_then(|group| group.synonyms.clone())
            .unwrap_or_default(),
        tolerance: match group.is_none_or(|group| group.typo_matches) {
            true => folding.tolerance,
            false => 0,
        },
        prefix_length: folding.prefix_length,
    }
}

fn phrase_request(token: &str, key: &str) -> FoldedWordRequest {
    FoldedWordRequest {
        key: key.to_string(),
        own: token.to_string(),
        excluded: Vec::new(),
        tolerance: 0,
        prefix_length: 0,
    }
}

/// Finds the variants and folded typo matches of each term in one partition, takes each variant out of its term's
/// group, and gives each phrase position its variants.
pub(crate) fn resolve_folding(
    sources: &ExpansionSources<'_>,
    folding: &FoldedWords,
    groups: &mut [TermGroup],
    phrases: &[AnalysedPhrase],
) -> Result<ResolvedFolding> {
    let mut requests: Vec<FoldedWordRequest> = folding
        .keys
        .iter()
        .map(|(token, key)| word_request(folding, groups, token, key))
        .collect();
    for (phrase, keys) in phrases.iter().zip(&folding.phrase_keys) {
        for (token, key) in phrase.tokens.iter().zip(keys) {
            requests.push(phrase_request(token, key));
        }
    }
    let mut found = sources
        .folded_terms(folding.language, &requests)?
        .into_iter();
    let mut folded = Vec::new();
    for (token, _) in &folding.keys {
        let Some(term) = found.next() else {
            break;
        };
        if term.variants.is_empty() && term.typo_matches.is_empty() {
            continue;
        }
        if let Some(group) = groups.iter_mut().find(|group| group.token == *token)
            && !term.variants.is_empty()
        {
            group
                .members
                .retain(|member| member.token == *token || !term.variants.contains(&member.token));
        }
        folded.push(FoldedQueryTerm {
            token: token.clone(),
            variants: term.variants,
            typo_matches: term.typo_matches,
        });
    }
    let mut widened = Vec::with_capacity(phrases.len());
    let mut any_variant = false;
    for phrase in phrases {
        let variants: Vec<Vec<String>> = phrase
            .tokens
            .iter()
            .map(|_| found.next().map(|term| term.variants).unwrap_or_default())
            .collect();
        any_variant |= variants.iter().any(|held| !held.is_empty());
        widened.push(AnalysedPhrase {
            variants,
            ..phrase.clone()
        });
    }
    Ok(ResolvedFolding {
        folded,
        phrases: any_variant.then_some(widened),
    })
}
