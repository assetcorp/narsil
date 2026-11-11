use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::{Arc, RwLock};

use crate::error::{ErrorCode, NarsilError, Result};
use crate::util::unwind::guarded;

/// One token that a [`Tokenizer`] returns: the term to index and its position in the text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Token {
    /// The term that the engine indexes and searches, as the tokenizer returns it.
    pub token: String,
    /// The position of the term in the text, counting from zero, which phrase search compares.
    pub position: u32,
}

/// Splits text into the terms that an index stores, in place of the analysis of the index's language.
///
/// The engine indexes each returned term as it stands, so a tokenizer that wants stemming or lower case applies
/// them itself, and the engine removes no stop word from what it returns. The engine sorts the tokens by position
/// where the tokenizer returns them out of order. Where `tokenize` panics, the write or search that called it fails
/// with `INTERNAL_ERROR` and the text that the panic carried, or with the [`crate::NarsilError`] that the panic
/// carried, and the index keeps what it held before.
pub trait Tokenizer: Send + Sync {
    /// Returns the tokens of `text`.
    fn tokenize(&self, text: &str) -> Vec<Token>;
}

/// A function that receives a language's stop words and returns the set that an index uses.
///
/// Where the function panics, the call that built the index's analysis fails with `CONFIG_INVALID` and the text
/// that the panic carried, or with the [`crate::NarsilError`] that the panic carried.
pub type StopWordFunction = Arc<dyn Fn(&HashSet<String>) -> HashSet<String> + Send + Sync>;

/// The stop words of an index, which replace the stop words of its language.
#[derive(Clone)]
pub enum StopWords {
    /// A fixed set of words.
    Set(HashSet<String>),
    /// A function that receives the language's stop words and returns the set to use.
    Function(StopWordFunction),
}

impl fmt::Debug for StopWords {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StopWords::Set(words) => formatter.debug_tuple("Set").field(words).finish(),
            StopWords::Function(_) => formatter.write_str("Function"),
        }
    }
}

impl StopWords {
    pub(crate) fn resolve(&self, defaults: &HashSet<String>) -> Result<HashSet<String>> {
        match self {
            StopWords::Set(words) => Ok(words.clone()),
            StopWords::Function(function) => {
                guarded(ErrorCode::CONFIG_INVALID, "The stop word function", || {
                    function(defaults)
                })
            }
        }
    }
}

/// The tokenizer and stop words that one index analyses with, after its names are looked up.
#[derive(Clone, Default)]
pub(crate) struct ResolvedAnalysis {
    pub(crate) stop_words: Option<StopWords>,
    pub(crate) tokenizer: Option<Arc<dyn Tokenizer>>,
}

/// The tokenizers and stop word sets that an engine holds under names, so that an index can store the name.
#[derive(Default)]
pub(crate) struct AnalysisRegistry {
    tokenizers: RwLock<HashMap<String, Arc<dyn Tokenizer>>>,
    stop_words: RwLock<HashMap<String, StopWords>>,
}

fn require_name(name: &str, kind: &str) -> Result<()> {
    if name.trim().is_empty() {
        return Err(NarsilError::new(
            ErrorCode::CONFIG_INVALID,
            format!("A registered {kind} needs a non-empty name"),
        ));
    }
    Ok(())
}

impl AnalysisRegistry {
    pub(crate) fn register_tokenizer(
        &self,
        name: &str,
        tokenizer: Arc<dyn Tokenizer>,
    ) -> Result<()> {
        require_name(name, "tokenizer")?;
        let mut held = self
            .tokenizers
            .write()
            .unwrap_or_else(|poison| poison.into_inner());
        held.insert(name.to_string(), tokenizer);
        Ok(())
    }

    pub(crate) fn register_stop_words(&self, name: &str, stop_words: StopWords) -> Result<()> {
        require_name(name, "stop word set")?;
        let mut held = self
            .stop_words
            .write()
            .unwrap_or_else(|poison| poison.into_inner());
        held.insert(name.to_string(), stop_words);
        Ok(())
    }

    pub(crate) fn tokenizer(&self, name: &str) -> Result<Arc<dyn Tokenizer>> {
        let held = self
            .tokenizers
            .read()
            .unwrap_or_else(|poison| poison.into_inner());
        held.get(name).cloned().ok_or_else(|| {
            NarsilError::new(
                ErrorCode::CONFIG_INVALID,
                format!("Tokenizer \"{name}\" is not registered on this engine"),
            )
        })
    }

    pub(crate) fn stop_words(&self, name: &str) -> Result<StopWords> {
        let held = self
            .stop_words
            .read()
            .unwrap_or_else(|poison| poison.into_inner());
        held.get(name).cloned().ok_or_else(|| {
            NarsilError::new(
                ErrorCode::CONFIG_INVALID,
                format!("Stop word set \"{name}\" is not registered on this engine"),
            )
        })
    }
}
