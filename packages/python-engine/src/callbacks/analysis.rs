use std::collections::HashSet;
use std::sync::Arc;

use narsil::{
    ErrorCode, NarsilError, StopWords, StopWordsSetting, Token, TokenSource, Tokenizer,
    TokenizerSetting,
};
use pyo3::prelude::*;
use pyo3::types::{PyByteArray, PyBytes, PyDict, PyFrozenSet, PyList, PySet, PyString, PyTuple};

use super::retained::Retained;
use super::{CallbackFailure, call_python};
use crate::convert::fields::{string_of, strings_of, whole_of};
use crate::errors::config_invalid;

const TOKENIZER_SUBJECT: &str = "The tokenizer";
const STOP_WORDS_SUBJECT: &str = "The stop word function";

fn kind_of(value: &Bound<'_, PyAny>) -> String {
    value
        .get_type()
        .name()
        .map(|name| name.to_string())
        .unwrap_or_else(|_| "object".to_string())
}

fn well_formed(text: &Bound<'_, PyString>) -> PyResult<String> {
    if let Ok(valid) = text.to_str() {
        return Ok(valid.to_string());
    }
    let encoded = text.call_method1("encode", ("utf-16-le", "surrogatepass"))?;
    let bytes = encoded.cast::<PyBytes>()?.as_bytes();
    let units = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u16::from_le_bytes(*pair));
    Ok(char::decode_utf16(units)
        .map(|decoded| decoded.unwrap_or(char::REPLACEMENT_CHARACTER))
        .collect())
}

fn entry_parts<'py>(
    entry: &Bound<'py, PyAny>,
) -> PyResult<Option<(Bound<'py, PyAny>, Bound<'py, PyAny>)>> {
    if let Ok(pair) = entry.cast::<PyTuple>() {
        if pair.len() != 2 {
            return Ok(None);
        }
        return Ok(Some((pair.get_item(0)?, pair.get_item(1)?)));
    }
    if let Ok(fields) = entry.cast::<PyDict>() {
        return Ok(fields.get_item("token")?.zip(fields.get_item("position")?));
    }
    Ok(None)
}

fn refusal(source: TokenSource, message: String) -> CallbackFailure {
    CallbackFailure::Coded(NarsilError::new(
        source.refusal_code(),
        format!("The custom tokenizer {message}"),
    ))
}

fn entries_of<'py>(
    returned: &Bound<'py, PyAny>,
    source: TokenSource,
) -> Result<Vec<Bound<'py, PyAny>>, CallbackFailure> {
    if let Ok(list) = returned.cast::<PyList>() {
        return Ok(list.iter().collect());
    }
    if let Ok(tuple) = returned.cast::<PyTuple>() {
        return Ok(tuple.iter().collect());
    }
    let iterable = returned.cast::<PyString>().is_err()
        && returned.cast::<PyBytes>().is_err()
        && returned.cast::<PyByteArray>().is_err()
        && returned.cast::<PyDict>().is_err();
    match returned.try_iter() {
        Ok(entries) if iterable => Ok(entries.collect::<PyResult<Vec<_>>>()?),
        _ => Err(refusal(
            source,
            format!(
                "returned a {}, where it returns an iterable of tokens",
                kind_of(returned)
            ),
        )),
    }
}

fn token_of(
    entry: &Bound<'_, PyAny>,
    at: usize,
    source: TokenSource,
) -> Result<Token, CallbackFailure> {
    let refused = |message: String| refusal(source, message);
    let Some((token, position)) = entry_parts(entry)? else {
        return Err(refused(format!(
            "returned a {} at entry {at}, where an entry is a (token, position) pair or a dict with \"token\" and \"position\"",
            kind_of(entry)
        )));
    };
    let Ok(text) = token.cast::<PyString>() else {
        return Err(refused(format!(
            "returned a token of type {} at entry {at}, where a token is a string",
            kind_of(&token)
        )));
    };
    let token = well_formed(text)?;
    let position = whole_of(&position, "position")
        .ok()
        .and_then(|position| u32::try_from(position).ok())
        .ok_or_else(|| {
            let shown = position
                .repr()
                .map(|text| text.to_string_lossy().into_owned())
                .unwrap_or_else(|_| kind_of(&position));
            refused(format!(
                "returned the position {shown} at entry {at}, where a position is a whole number from 0 to {}",
                u32::MAX
            ))
        })?;
    Ok(Token { token, position })
}

pub(crate) struct PythonTokenizer {
    object: Retained,
}

impl Tokenizer for PythonTokenizer {
    fn tokenize(&self, text: &str) -> Vec<Token> {
        match self.try_tokenize(text, TokenSource::Document) {
            Ok(tokens) => tokens,
            Err(error) => std::panic::resume_unwind(Box::new(error)),
        }
    }

    fn try_tokenize(&self, text: &str, source: TokenSource) -> narsil::Result<Vec<Token>> {
        let reentry = self.object.awaited_by_engine();
        call_python(
            ErrorCode::INTERNAL_ERROR,
            TOKENIZER_SUBJECT,
            reentry,
            |py| {
                let returned = self.object.bind(py)?.call_method1("tokenize", (text,))?;
                let entries = entries_of(&returned, source)?;
                let mut tokens = Vec::with_capacity(entries.len());
                for (at, entry) in entries.iter().enumerate() {
                    tokens.push(token_of(entry, at, source)?);
                }
                Ok(tokens)
            },
        )
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
        object: Retained::new(value),
    }))
}

fn word_set(value: &Bound<'_, PyAny>, label: &str) -> Result<HashSet<String>, NarsilError> {
    Ok(strings_of(value, label)?.into_iter().collect())
}

fn stop_word_function(function: Retained) -> StopWords {
    StopWords::Function(Arc::new(move |defaults: &HashSet<String>| {
        let mut sorted: Vec<&String> = defaults.iter().collect();
        sorted.sort();
        let reentry = function.awaited_by_engine();
        let chosen = call_python(
            ErrorCode::CONFIG_INVALID,
            STOP_WORDS_SUBJECT,
            reentry,
            |py| {
                let defaults = PyFrozenSet::new(py, &sorted)?;
                let chosen = function.bind(py)?.call1((defaults,))?;
                Ok(word_set(
                    &chosen,
                    "the stop words that the function returned",
                )?)
            },
        );
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
        return Ok(stop_word_function(Retained::new(value)));
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
