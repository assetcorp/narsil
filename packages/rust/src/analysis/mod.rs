mod core;
mod registry;

use std::collections::HashSet;
use std::sync::{Arc, OnceLock};

pub(crate) use registry::{AnalysisRegistry, ResolvedAnalysis};
pub use registry::{StopWordFunction, StopWords, Token, Tokenizer};

use crate::error::{ErrorCode, NarsilError, Result};
use crate::ffi;
use crate::keyword::tokens::PackedTokens;
use core::{CoreStopWords, TokenParts};

/// A language that the native core analyses, with its stop words and the revision of its analysis.
#[derive(Clone)]
pub struct Language {
    index: u32,
    name: &'static str,
    revision: &'static str,
    stop_words: Arc<HashSet<String>>,
}

impl std::fmt::Debug for Language {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Language")
            .field("name", &self.name)
            .field("revision", &self.revision)
            .finish()
    }
}

fn every_language() -> &'static Vec<Language> {
    static LANGUAGES: OnceLock<Vec<Language>> = OnceLock::new();
    LANGUAGES.get_or_init(|| {
        (0..core::language_count())
            .map(|index| Language {
                index,
                name: core::language_name(index),
                revision: core::language_revision(index),
                stop_words: Arc::new(core::language_stop_words(index).into_iter().collect()),
            })
            .collect()
    })
}

impl Language {
    /// Returns the language that an index names as its `language`, such as `english`.
    ///
    /// Raises `LANGUAGE_NOT_SUPPORTED` for a name that the native core holds no module for.
    pub fn named(name: &str) -> Result<Language> {
        core::language_index(name)
            .and_then(|index| every_language().get(index as usize))
            .cloned()
            .ok_or_else(|| {
                NarsilError::new(
                    ErrorCode::LANGUAGE_NOT_SUPPORTED,
                    format!("Language \"{name}\" is not registered"),
                )
            })
    }

    /// Returns every language that the native core analyses, in the core's order.
    pub fn all() -> Vec<Language> {
        every_language().clone()
    }

    /// Returns the name that an index configuration sets as its `language`.
    pub fn name(&self) -> &'static str {
        self.name
    }

    /// Returns the fingerprint of this language's analysis, which an index records so that it can tell when its
    /// terms came from an earlier analysis.
    pub fn revision(&self) -> &'static str {
        self.revision
    }

    /// Returns the words that this language drops before it indexes or searches text.
    pub fn stop_words(&self) -> &HashSet<String> {
        &self.stop_words
    }

    pub(crate) fn core_index(&self) -> u32 {
        self.index
    }
}

pub(crate) use core::with_core_analyser;

/// What to do with each token while text is analysed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TokenOptions {
    pub(crate) stem: bool,
    pub(crate) remove_stop_words: bool,
    pub(crate) remove_diacritics: bool,
    pub(crate) collect_surfaces: bool,
}

impl TokenOptions {
    pub(crate) const INDEXING: TokenOptions = TokenOptions {
        stem: true,
        remove_stop_words: true,
        remove_diacritics: false,
        collect_surfaces: false,
    };

    fn flags(self) -> u32 {
        let mut flags = 0;
        if self.stem {
            flags |= ffi::NARSIL_ANALYSE_STEM;
        }
        if self.remove_stop_words {
            flags |= ffi::NARSIL_ANALYSE_REMOVE_STOP_WORDS;
        }
        if self.remove_diacritics {
            flags |= ffi::NARSIL_ANALYSE_REMOVE_DIACRITICS;
        }
        if self.collect_surfaces {
            flags |= ffi::NARSIL_ANALYSE_COLLECT_SURFACES;
        }
        flags
    }
}

/// The analysis of one index: its language, its stop words, and its tokeniser.
/// Receives each token of a text: the term, its position, the surface form where it differs, and the raw token.
pub(crate) type TokenVisitor<'a> = dyn FnMut(&str, u32, Option<&str>, &str) + 'a;

#[derive(Clone)]
pub(crate) struct Analyser {
    language: Language,
    stop_words: Option<Arc<CoreStopWords>>,
    sets_stop_words: bool,
    tokenizer: Option<Arc<dyn Tokenizer>>,
}

impl Analyser {
    pub(crate) fn new(language: Language, resolved: &ResolvedAnalysis) -> Result<Analyser> {
        let stop_words = match &resolved.stop_words {
            None => None,
            Some(stop_words) => {
                let words = stop_words.resolve(&language.stop_words);
                if words.len() == language.stop_words.len()
                    && words.iter().all(|word| language.stop_words.contains(word))
                {
                    None
                } else {
                    Some(Arc::new(CoreStopWords::of(
                        words.iter().map(String::as_str),
                    )?))
                }
            }
        };
        Ok(Analyser {
            language,
            stop_words,
            sets_stop_words: resolved.stop_words.is_some(),
            tokenizer: resolved.tokenizer.clone(),
        })
    }

    pub(crate) fn sets_tokenizer_or_stop_words(&self) -> bool {
        self.tokenizer.is_some() || self.sets_stop_words
    }

    pub(crate) fn language(&self) -> &Language {
        &self.language
    }

    pub(crate) fn has_custom_tokenizer(&self) -> bool {
        self.tokenizer.is_some()
    }

    pub(crate) fn visit_tokens(
        &self,
        text: &str,
        options: TokenOptions,
        visit: &mut TokenVisitor<'_>,
    ) -> Result<()> {
        if let Some(tokenizer) = &self.tokenizer {
            let mut tokens = tokenizer.tokenize(text);
            if tokens
                .windows(2)
                .any(|pair| pair[1].position < pair[0].position)
            {
                tokens.sort_by_key(|token| token.position);
            }
            for token in &tokens {
                visit(&token.token, token.position, None, &token.token);
            }
            return Ok(());
        }
        let stop_words = if options.remove_stop_words {
            self.stop_words.as_deref()
        } else {
            None
        };
        let mut term = String::new();
        let mut surface = String::new();
        let mut original = String::new();
        core::analyse(
            self.language.index,
            stop_words,
            options.flags(),
            text,
            &mut |parts: TokenParts<'_>| {
                fill(&mut term, parts.term);
                fill(&mut original, parts.original);
                match parts.surface {
                    Some(units) => {
                        fill(&mut surface, units);
                        visit(&term, parts.position, Some(&surface), &original);
                    }
                    None => visit(&term, parts.position, None, &original),
                }
            },
        )
    }

    pub(crate) fn pack_text(
        &self,
        text: &str,
        options: TokenOptions,
        position: u32,
        packed: &mut PackedTokens,
    ) -> Result<Option<u32>> {
        if let Some(tokenizer) = &self.tokenizer {
            let mut tokens = tokenizer.tokenize(text);
            if tokens
                .windows(2)
                .any(|pair| pair[1].position < pair[0].position)
            {
                tokens.sort_by_key(|token| token.position);
            }
            let mut units = Vec::new();
            for token in &tokens {
                units.clear();
                units.extend(token.token.encode_utf16());
                packed.push(&units, position.saturating_add(token.position), None)?;
            }
            return Ok(tokens.last().map(|token| token.position));
        }
        let stop_words = if options.remove_stop_words {
            self.stop_words.as_deref()
        } else {
            None
        };
        let mut last = None;
        core::analyse_packed(
            self.language.index,
            stop_words,
            options.flags(),
            text,
            &mut |records, units| {
                last = packed.append(records, units, position)?;
                Ok(())
            },
        )?;
        Ok(last)
    }

    pub(crate) fn transform(
        &self,
        raw: &str,
        stem: bool,
        remove_diacritics: bool,
    ) -> Result<String> {
        let mut flags = 0;
        if stem {
            flags |= ffi::NARSIL_ANALYSE_STEM;
        }
        if remove_diacritics {
            flags |= ffi::NARSIL_ANALYSE_REMOVE_DIACRITICS;
        }
        core::transform(self.language.index, flags, raw)
    }
}

fn fill(target: &mut String, units: &[u16]) {
    target.clear();
    for decoded in char::decode_utf16(units.iter().copied()) {
        target.push(decoded.unwrap_or(char::REPLACEMENT_CHARACTER));
    }
}
