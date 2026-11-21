use narsil::{Map, Value};

use super::metadata::{is_safe_count, is_sync_epoch};

fn is_positive_count(value: &Value) -> bool {
    is_safe_count(value) && matches!(value, Value::Number(number) if *number >= 1.0)
}

fn history_is_valid(raw: &Value) -> bool {
    let Value::Object(history) = raw else {
        return false;
    };
    matches!(history.get("enabled"), Some(Value::Bool(_)))
        && history.get("historyMaxAgeMs").is_none_or(is_positive_count)
        && history.get("historyMaxBytes").is_none_or(is_positive_count)
}

fn is_optional_text(value: Option<&Value>) -> bool {
    value.is_none_or(|value| matches!(value, Value::String(_)))
}

fn is_text(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::String(_)))
}

fn pending_analysis_is_valid(raw: &Value) -> bool {
    let Value::Object(pending) = raw else {
        return false;
    };
    let stop_word_list_valid = match pending.get("stopWordList") {
        None => true,
        Some(Value::Array(words)) => words.iter().all(|word| matches!(word, Value::String(_))),
        Some(_) => false,
    };
    is_text(pending.get("changeId"))
        && pending.get("generation").is_some_and(is_safe_count)
        && is_text(pending.get("language"))
        && is_optional_text(pending.get("tokenizer"))
        && is_optional_text(pending.get("stopWords"))
        && stop_word_list_valid
}

fn analysis_failure_is_valid(raw: &Value) -> bool {
    let Value::Object(failure) = raw else {
        return false;
    };
    ["changeId", "code", "message", "nodeId"]
        .iter()
        .all(|field| is_text(failure.get(field)))
}

fn readable(settings: &Map) -> bool {
    let language_named =
        matches!(settings.get("language"), Some(Value::String(language)) if !language.is_empty());
    language_named
        && settings.get("bm25Revision").is_none_or(is_safe_count)
        && settings.get("analysisGeneration").is_none_or(is_safe_count)
        && settings
            .get("pendingAnalysis")
            .is_none_or(pending_analysis_is_valid)
        && settings
            .get("analysisFailure")
            .is_none_or(analysis_failure_is_valid)
        && settings.get("sync").is_none_or(history_is_valid)
        && settings.get("changes").is_none_or(changes_are_valid)
        && settings
            .get("syncActive")
            .is_none_or(|active| matches!(active, Value::Bool(_)))
        && settings.get("syncEpoch").is_none_or(is_sync_epoch)
}

fn changes_are_valid(raw: &Value) -> bool {
    let previous_document = raw
        .as_object()
        .and_then(|changes| changes.get("previousDocument"));
    history_is_valid(raw) && previous_document.is_none_or(|flag| matches!(flag, Value::Bool(_)))
}

pub(crate) fn previous_documents_recorded(settings: Option<&Value>) -> bool {
    let settings = match settings {
        None | Some(Value::Null) => return false,
        Some(Value::Object(settings)) => settings,
        Some(_) => return true,
    };
    if !readable(settings) {
        return true;
    }
    let Some(Value::Object(changes)) = settings.get("changes") else {
        return false;
    };
    matches!(changes.get("enabled"), Some(Value::Bool(true)))
        && matches!(changes.get("previousDocument"), Some(Value::Bool(true)))
}
