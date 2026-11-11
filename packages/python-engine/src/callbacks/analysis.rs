use std::collections::HashSet;
use std::sync::Arc;

use narsil::{
    ErrorCode, NarsilError, StopWords, StopWordsSetting, Token, Tokenizer, TokenizerSetting,
};
use pyo3::prelude::*;
use pyo3::types::{PyDict, PyFrozenSet, PySet, PyString, PyTuple};

use super::{CallbackFailure, call_python};
use crate::convert::fields::{items_of, string_of, strings_of, whole_of};
use crate::errors::config_invalid;

const TOKENIZER_SUBJECT: &str = "The tokenizer";
const STOP_WORDS_SUBJECT: &str = "The stop word function";

fn token_of(entry: &Bound<'_, PyAny>, at: usize) -> Result<Token, NarsilError> {
    let label = format!("the token at entry {at}");
    let (token, position) = if let Ok(pair) = entry.cast::<PyTuple>() {
        if pair.len() != 2 {
            return Err(config_invalid(format!(
                "{label} must be a (token, position) pair"
            )));
        }
        (
            pair.get_item(0)
                .map_err(|error| config_invalid(error.to_string()))?,
            pair.get_item(1)
                .map_err(|error| config_invalid(error.to_string()))?,
        )
    } else if let Ok(fields) = entry.cast::<PyDict>() {
        let token = fields
            .get_item("token")
            .map_err(|error| config_invalid(error.to_string()))?;
        let position = fields
            .get_item("position")
            .map_err(|error| config_invalid(error.to_string()))?;
        match (token, position) {
            (Some(token), Some(position)) => (token, position),
            _ => {
                return Err(config_invalid(format!(
                    "{label} must hold \"token\" and \"position\""
                )));
            }
        }
    } else {
        return Err(config_invalid(format!(
            "{label} must be a dict with \"token\" and \"position\" or a (token, position) pair"
        )));
    };
    let token = string_of(&token, &format!("{label} token"))?;
    let position = whole_of(&position, &format!("{label} position"))?;
    let position = u32::try_from(position)
        .map_err(|_| config_invalid(format!("{label} position must be at most {}", u32::MAX)))?;
    Ok(Token { token, position })
}

pub(crate) struct PythonTokenizer {
    object: Py<PyAny>,
}

impl PythonTokenizer {
    fn tokens(&self, text: &str) -> Result<Vec<Token>, NarsilError> {
        call_python(ErrorCode::INTERNAL_ERROR, TOKENIZER_SUBJECT, |py| {
            let entries = self.object.bind(py).call_method1("tokenize", (text,))?;
            let entries = items_of(&entries, "the list that tokenize returned")?;
            let mut tokens = Vec::with_capacity(entries.len());
            for (at, entry) in entries.iter().enumerate() {
                tokens.push(token_of(entry, at).map_err(CallbackFailure::Refused)?);
            }
            Ok(tokens)
        })
    }
}

impl Tokenizer for PythonTokenizer {
    fn tokenize(&self, text: &str) -> Vec<Token> {
        match self.tokens(text) {
            Ok(tokens) => tokens,
            Err(error) => std::panic::resume_unwind(Box::new(error)),
        }
    }
}

pub(crate) fn tokenizer_setting(
    value: &Bound<'_, PyAny>,
    label: &str,
) -> Result<TokenizerSetting, NarsilError> {
    if value.cast::<PyString>().is_ok() {
        return Ok(TokenizerSetting::Named(string_of(value, label)?));
    }
    Ok(TokenizerSetting::Instance(tokenizer_object(value, label)?))
}

pub(crate) fn tokenizer_object(
    value: &Bound<'_, PyAny>,
    label: &str,
) -> Result<Arc<dyn Tokenizer>, NarsilError> {
    let tokenizes = value
        .getattr("tokenize")
        .map(|tokenize| tokenize.is_callable())
        .unwrap_or(false);
    if !tokenizes {
        return Err(config_invalid(format!(
            "{label} must be a name or an object with a tokenize(text) method"
        )));
    }
    Ok(Arc::new(PythonTokenizer {
        object: value.clone().unbind(),
    }))
}

fn word_set(value: &Bound<'_, PyAny>, label: &str) -> Result<HashSet<String>, NarsilError> {
    Ok(strings_of(value, label)?.into_iter().collect())
}

fn stop_word_function(function: Py<PyAny>) -> StopWords {
    StopWords::Function(Arc::new(move |defaults: &HashSet<String>| {
        let mut sorted: Vec<&String> = defaults.iter().collect();
        sorted.sort();
        let chosen = call_python(ErrorCode::CONFIG_INVALID, STOP_WORDS_SUBJECT, |py| {
            let defaults = PyFrozenSet::new(py, &sorted)?;
            let chosen = function.bind(py).call1((defaults,))?;
            Ok(word_set(
                &chosen,
                "the stop words that the function returned",
            )?)
        });
        match chosen {
            Ok(words) => words,
            Err(error) => std::panic::resume_unwind(Box::new(error)),
        }
    }))
}

pub(crate) fn stop_words_value(
    value: &Bound<'_, PyAny>,
    label: &str,
) -> Result<StopWords, NarsilError> {
    if value.cast::<PyString>().is_err() && value.is_callable() {
        return Ok(stop_word_function(value.clone().unbind()));
    }
    if value.cast::<PySet>().is_ok() || value.cast::<PyFrozenSet>().is_ok() {
        let words: Vec<String> = value
            .try_iter()
            .map_err(|error| config_invalid(error.to_string()))?
            .map(|word| {
                word.map_err(|error| config_invalid(error.to_string()))
                    .and_then(|word| string_of(&word, label))
            })
            .collect::<Result<_, _>>()?;
        return Ok(StopWords::Set(words.into_iter().collect()));
    }
    Ok(StopWords::Set(word_set(value, label)?))
}

pub(crate) fn stop_words_setting(
    value: &Bound<'_, PyAny>,
    label: &str,
) -> Result<StopWordsSetting, NarsilError> {
    if value.cast::<PyString>().is_ok() {
        return Ok(StopWordsSetting::Named(string_of(value, label)?));
    }
    Ok(StopWordsSetting::Words(stop_words_value(value, label)?))
}
