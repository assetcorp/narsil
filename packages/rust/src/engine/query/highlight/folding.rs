use std::collections::HashMap;

use crate::analysis::Language;
use crate::error::Result;
use crate::search::fuzzy::fuzzy_term_matches;
use crate::search::phrase::AnalysedPhrase;

pub(super) struct HighlightFolding {
    pub(super) language: Language,
    pub(super) keys: Vec<(String, u32)>,
    pub(super) prefix: Option<String>,
    pub(super) partial_words: Vec<String>,
}

pub(super) struct FoldedHighlightInputs<'a> {
    pub(super) query: &'a [(String, u32, u32)],
    pub(super) written: &'a [(String, u32)],
    pub(super) phrases: &'a [AnalysedPhrase],
    pub(super) prefix_token: Option<&'a str>,
    pub(super) partial_words: &'a [String],
}

fn held_fold(fold: String) -> Option<String> {
    (!fold.is_empty()).then_some(fold)
}

pub(super) fn highlight_folding(
    language: &Language,
    inputs: FoldedHighlightInputs<'_>,
) -> Result<HighlightFolding> {
    let mut written_at: HashMap<u32, &str> = HashMap::new();
    for (word, position) in inputs.written {
        written_at.entry(*position).or_insert(word);
    }
    let mut keys = Vec::new();
    for (token, tolerance, position) in inputs.query {
        let word = written_at.get(position).copied().unwrap_or(token);
        keys.push((language.fold_spelling(word, true)?, *tolerance));
    }
    for phrase in inputs.phrases {
        for (at, token) in phrase.tokens.iter().enumerate() {
            let word = phrase.written.get(at).unwrap_or(token);
            keys.push((language.fold_spelling(word, true)?, 0));
        }
    }
    let prefix = match inputs.prefix_token {
        Some(word) => held_fold(language.fold_spelling(word, false)?),
        None => None,
    };
    let mut partial_words = Vec::with_capacity(inputs.partial_words.len());
    for word in inputs.partial_words {
        if let Some(fold) = held_fold(language.fold_spelling(word, false)?) {
            partial_words.push(fold);
        }
    }
    Ok(HighlightFolding {
        language: language.clone(),
        keys,
        prefix,
        partial_words,
    })
}

impl HighlightFolding {
    pub(super) fn matches(&self, spelling: &str, prefix_length: u32) -> Result<bool> {
        if let Some(prefix) = &self.prefix
            && self
                .language
                .fold_spelling(spelling, false)?
                .starts_with(prefix.as_str())
        {
            return Ok(true);
        }
        if self.keys.is_empty() {
            return Ok(false);
        }
        let key = self.language.fold_spelling(spelling, true)?;
        Ok(self
            .keys
            .iter()
            .any(|(query, tolerance)| fuzzy_term_matches(query, &key, *tolerance, prefix_length)))
    }

    pub(super) fn fold(&self, spelling: &str) -> Result<String> {
        self.language.fold_spelling(spelling, false)
    }
}
