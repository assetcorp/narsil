use std::collections::HashMap;

use super::constants::{PARTIAL_WORD_MIN_CODE_POINTS, PARTIAL_WORDS_ADDED_PER_QUERY};
use super::folding::{FoldedWords, FoldingInputs, plan_folding, resolve_folding};
use crate::analysis::{Analyser, Language, TokenOptions};
use crate::error::Result;
use crate::index::partition::PartitionSnapshot;
use crate::keyword::expansion::{ExpansionSources, PartialWordRequest};
use crate::search::phrase::AnalysedPhrase;
use crate::search::query::{FoldedQueryTerm, GroupMember, TermGroup};

/// The last word of a query, as an index token and as the query wrote it, which a prefix search completes.
pub(crate) struct PrefixWord {
    pub(crate) token: String,
    pub(crate) written: String,
}

/// How a query widens its words in every partition: the last word that it completes, and the words that it looks
/// for inside longer words of its partial-word fields.
#[derive(Default)]
pub(crate) struct WordExpansion {
    pub(crate) prefix: Option<PrefixWord>,
    pub(crate) partial: Vec<PartialWordRequest>,
    pub(crate) partial_fields: Vec<String>,
    pub(crate) synonyms: Vec<(String, Vec<String>)>,
    pub(crate) folding: Option<FoldedWords>,
}

/// What a query asks of its words, which [`plan_word_expansion`] turns into a [`WordExpansion`].
pub(crate) struct ExpansionInputs<'a> {
    pub(crate) words: &'a str,
    pub(crate) tokens: &'a [(String, u32)],
    pub(crate) last: Option<(String, u32)>,
    pub(crate) completes_last_word: bool,
    pub(crate) partial_fields: Vec<String>,
    pub(crate) tolerance: u32,
    pub(crate) prefix_length: u32,
    pub(crate) folds: Option<&'a Language>,
    pub(crate) phrases: &'a [AnalysedPhrase],
}

/// Returns the first unstemmed word at each position of `text`, after stop word removal.
fn written_words_by_position(analyser: &Analyser, text: &str) -> Result<HashMap<u32, String>> {
    let options = TokenOptions {
        stem: false,
        ..TokenOptions::INDEXING
    };
    let mut written: HashMap<u32, String> = HashMap::new();
    analyser.visit_tokens(text, options, &mut |term, position, _, _| {
        written.entry(position).or_insert_with(|| term.to_string());
    })?;
    Ok(written)
}

fn partial_word_requests(
    inputs: &ExpansionInputs<'_>,
    written: &HashMap<u32, String>,
    prefix_token: Option<&str>,
) -> Vec<PartialWordRequest> {
    let mut eligible: Vec<(&str, &str)> = Vec::new();
    for (token, position) in inputs.tokens {
        let Some(word) = written.get(position) else {
            continue;
        };
        if word.chars().count() < PARTIAL_WORD_MIN_CODE_POINTS {
            continue;
        }
        eligible.push((token, word));
        if eligible.len() == PARTIAL_WORDS_ADDED_PER_QUERY {
            break;
        }
    }
    eligible
        .into_iter()
        .map(|(token, word)| PartialWordRequest {
            token: token.to_string(),
            written: word.to_string(),
            tolerance: if Some(token) == prefix_token {
                0
            } else {
                inputs.tolerance
            },
            prefix_length: inputs.prefix_length,
        })
        .collect()
}

/// Decides how a query widens its words, from the words-only text of its term.
pub(crate) fn plan_word_expansion(
    analyser: &Analyser,
    inputs: ExpansionInputs<'_>,
) -> Result<WordExpansion> {
    let uses_partial_words = !inputs.partial_fields.is_empty();
    if !inputs.completes_last_word && !uses_partial_words && inputs.folds.is_none() {
        return Ok(WordExpansion::default());
    }
    let written = written_words_by_position(analyser, inputs.words)?;
    let prefix = match (&inputs.last, inputs.completes_last_word) {
        (Some((token, position)), true) => written
            .get(position)
            .filter(|word| !word.is_empty())
            .map(|word| PrefixWord {
                token: token.clone(),
                written: word.clone(),
            }),
        _ => None,
    };
    let prefix_token = prefix.as_ref().map(|word| word.token.as_str());
    let partial = match uses_partial_words {
        true => partial_word_requests(&inputs, &written, prefix_token),
        false => Vec::new(),
    };
    let folding = match inputs.folds {
        Some(language) => Some(plan_folding(
            language,
            FoldingInputs {
                tokens: inputs.tokens,
                written: &written,
                prefix_written: prefix.as_ref().map(|word| word.written.as_str()),
                partial: &partial,
                phrases: inputs.phrases,
                tolerance: inputs.tolerance,
                prefix_length: inputs.prefix_length,
            },
        )?),
        None => None,
    };
    Ok(WordExpansion {
        prefix,
        partial,
        partial_fields: inputs.partial_fields,
        synonyms: Vec::new(),
        folding,
    })
}

fn group_for<'a>(
    groups: &'a mut Vec<TermGroup>,
    token: &str,
    typo_matches: bool,
) -> &'a mut TermGroup {
    let at = match groups.iter().position(|group| group.token == token) {
        Some(at) => at,
        None => {
            groups.push(TermGroup {
                token: token.to_string(),
                members: vec![GroupMember {
                    token: token.to_string(),
                    factor: 1.0,
                    partial_factor: 1.0,
                }],
                typo_matches,
                synonyms: None,
            });
            groups.len() - 1
        }
    };
    &mut groups[at]
}

fn add_completions(
    groups: &mut Vec<TermGroup>,
    sources: &ExpansionSources<'_>,
    word: &PrefixWord,
    folding: Option<&FoldedWords>,
) -> Result<()> {
    let completions = match folding.and_then(|folding| {
        folding
            .prefix_fold
            .as_deref()
            .map(|fold| (folding.language, fold))
    }) {
        Some((language, fold)) => {
            sources.complete_folded_prefix(language, &word.written, &word.token, fold)?
        }
        None => sources.complete_prefix(&word.written, &word.token)?,
    };
    let group = group_for(groups, &word.token, false);
    for (completion, factor) in completions {
        group.members.push(GroupMember {
            token: completion,
            factor,
            partial_factor: factor,
        });
    }
    Ok(())
}

fn add_partial_words(group: &mut TermGroup, added: Vec<(String, f64)>) {
    for (token, factor) in added {
        match group
            .members
            .iter_mut()
            .find(|member| member.token == token)
        {
            Some(member) => member.partial_factor = member.partial_factor.max(factor),
            None => group.members.push(GroupMember {
                token,
                factor: 0.0,
                partial_factor: factor,
            }),
        }
    }
}

/// The term groups of one partition, with the partial-word fields that their factors apply to, the terms that
/// folded matching widens, and the phrases with the variants of each position where folding found any.
pub(crate) struct PartitionGroups {
    pub(crate) groups: Vec<TermGroup>,
    pub(crate) partial_fields: Vec<String>,
    pub(crate) folded: Vec<FoldedQueryTerm>,
    pub(crate) phrases: Option<Vec<AnalysedPhrase>>,
}

fn partial_additions(
    sources: &ExpansionSources<'_>,
    expansion: &WordExpansion,
) -> Result<Vec<Vec<(String, f64)>>> {
    if expansion.partial.is_empty() {
        return Ok(Vec::new());
    }
    match &expansion.folding {
        Some(folding) => sources.folded_partial_additions(
            folding.language,
            &expansion.partial,
            &folding.partial_folds,
        ),
        None => sources.partial_additions(&expansion.partial),
    }
}

/// Returns the term groups of one partition: the completions of the last word where the query asks for a prefix
/// search, the longer words that hold a query word where it asks for partial words, and, in an index that folds,
/// the variants of each term and phrase word.
pub(crate) fn resolve_term_groups(
    snapshot: &PartitionSnapshot,
    expansion: &WordExpansion,
    phrases: &[AnalysedPhrase],
) -> Result<PartitionGroups> {
    let mut groups = Vec::new();
    let mut sources = None;
    if expansion.prefix.is_some() || !expansion.partial.is_empty() {
        let held = sources.insert(ExpansionSources::of(snapshot)?);
        if let Some(word) = &expansion.prefix {
            add_completions(&mut groups, held, word, expansion.folding.as_ref())?;
        }
        let prefix_token = expansion.prefix.as_ref().map(|word| word.token.as_str());
        let additions = partial_additions(held, expansion)?;
        for (request, added) in expansion.partial.iter().zip(additions) {
            if added.is_empty() {
                continue;
            }
            let typo_matches = Some(request.token.as_str()) != prefix_token;
            add_partial_words(group_for(&mut groups, &request.token, typo_matches), added);
        }
    }
    for (token, synonyms) in &expansion.synonyms {
        let group = group_for(&mut groups, token, true);
        group
            .members
            .retain(|member| member.token == *token || !synonyms.contains(&member.token));
        group.synonyms = Some(synonyms.clone());
    }
    let resolved = match &expansion.folding {
        Some(folding) => {
            let held = match sources {
                Some(held) => held,
                None => ExpansionSources::of(snapshot)?,
            };
            Some(resolve_folding(&held, folding, &mut groups, phrases)?)
        }
        None => None,
    };
    let partial_fields = match groups.is_empty() {
        true => Vec::new(),
        false => expansion.partial_fields.clone(),
    };
    let (folded, phrases) = match resolved {
        Some(resolved) => (resolved.folded, resolved.phrases),
        None => (Vec::new(), None),
    };
    Ok(PartitionGroups {
        groups,
        partial_fields,
        folded,
        phrases,
    })
}
