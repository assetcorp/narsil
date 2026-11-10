use super::positive_integer;
use crate::format::fields::string_list;
use crate::value::{Map, Value};

#[derive(Debug, Clone, PartialEq, Default)]
pub(crate) struct NamedAnalysis {
    pub(crate) tokenizer: Option<String>,
    pub(crate) stop_words: Option<String>,
    pub(crate) stop_word_list: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PendingAnalysis {
    pub(crate) generation: u64,
    pub(crate) language: String,
    pub(crate) analysis: NamedAnalysis,
}

pub(crate) fn named_analysis_to_wire(map: &mut Map, analysis: &NamedAnalysis) {
    if let Some(tokenizer) = &analysis.tokenizer {
        map.insert("tokenizer", Value::String(tokenizer.clone()));
    }
    if let Some(stop_words) = &analysis.stop_words {
        map.insert("stop_words", Value::String(stop_words.clone()));
    }
    if let Some(list) = &analysis.stop_word_list {
        map.insert(
            "stop_word_list",
            Value::Array(list.iter().cloned().map(Value::String).collect()),
        );
    }
}

pub(crate) fn pending_from_wire(value: Option<&Value>) -> Option<PendingAnalysis> {
    let Value::Object(map) = value? else {
        return None;
    };
    let generation = positive_integer(map.get("generation"))?;
    let language = map.get("language")?.as_str()?.to_string();
    Some(PendingAnalysis {
        generation,
        language,
        analysis: NamedAnalysis {
            tokenizer: map
                .get("tokenizer")
                .and_then(Value::as_str)
                .map(str::to_string),
            stop_words: map
                .get("stop_words")
                .and_then(Value::as_str)
                .map(str::to_string),
            stop_word_list: string_list(map.get("stop_word_list")),
        },
    })
}
