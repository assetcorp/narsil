use std::collections::HashSet;

use narsil::{AnalysisChange, AnalysisSetting, Map, StopWords, StopWordsSetting, Value};

use crate::errors::ServerError;

const ANALYSIS_CHANGE_MEMBERS: [&str; 3] = ["language", "tokenizer", "stopWords"];

fn is_word_list(value: &Value) -> bool {
    matches!(value, Value::Array(words) if words.iter().all(|word| matches!(word, Value::String(_))))
}

fn validate(fields: &Map) -> Result<(), ServerError> {
    if let Some(unknown) = fields
        .keys()
        .find(|field| !ANALYSIS_CHANGE_MEMBERS.contains(&field.as_str()))
    {
        return Err(ServerError::invalid(format!(
            "Field \"{unknown}\" is not an analysis setting"
        )));
    }
    if fields
        .get("language")
        .is_some_and(|language| !matches!(language, Value::String(_)))
    {
        return Err(ServerError::invalid("Field \"language\" must be a string"));
    }
    if fields
        .get("tokenizer")
        .is_some_and(|tokenizer| !matches!(tokenizer, Value::Null | Value::String(_)))
    {
        return Err(ServerError::invalid(
            "Field \"tokenizer\" must be a registered name or null",
        ));
    }
    match fields.get("stopWords") {
        None | Some(Value::Null | Value::String(_)) => Ok(()),
        Some(words) if is_word_list(words) => Ok(()),
        Some(_) => Err(ServerError::invalid(
            "Field \"stopWords\" must be a registered name, a list of words, or null",
        )),
    }
}

fn stop_words_of(value: Option<&Value>) -> AnalysisSetting<StopWordsSetting> {
    match value {
        None => AnalysisSetting::Keep,
        Some(Value::String(name)) => AnalysisSetting::Set(StopWordsSetting::Named(name.clone())),
        Some(Value::Array(words)) => {
            let words: HashSet<String> = words
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect();
            AnalysisSetting::Set(StopWordsSetting::Words(StopWords::Set(words)))
        }
        Some(_) => AnalysisSetting::LanguageDefault,
    }
}

pub(crate) fn analysis_change_of(body: &Value) -> Result<AnalysisChange, ServerError> {
    let Value::Object(fields) = body else {
        return Err(ServerError::invalid("The request body must be an object"));
    };
    validate(fields)?;
    Ok(AnalysisChange {
        language: fields
            .get("language")
            .and_then(Value::as_str)
            .map(str::to_string),
        tokenizer: match fields.get("tokenizer") {
            None => AnalysisSetting::Keep,
            Some(Value::String(name)) => AnalysisSetting::Set(name.clone()),
            Some(_) => AnalysisSetting::LanguageDefault,
        },
        stop_words: stop_words_of(fields.get("stopWords")),
    })
}
