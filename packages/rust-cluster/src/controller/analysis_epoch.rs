use narsil::{Map, Value};

use super::analysis_metadata::PendingAnalysis;

fn history_enabled(settings: &Map, key: &str) -> bool {
    matches!(
        settings.get(key),
        Some(Value::Object(history)) if matches!(history.get("enabled"), Some(Value::Bool(true)))
    )
}

fn holds_text(settings: &Map, key: &str, wanted: Option<&str>) -> bool {
    match settings.get(key) {
        None => wanted.is_none(),
        Some(Value::String(text)) => wanted == Some(text.as_str()),
        Some(_) => false,
    }
}

fn holds_word_list(settings: &Map, wanted: Option<&[String]>) -> bool {
    match (settings.get("stopWordList"), wanted) {
        (None, None) => true,
        (Some(Value::Array(words)), Some(wanted)) => {
            words.len() == wanted.len()
                && words
                    .iter()
                    .zip(wanted)
                    .all(|(word, wanted)| word.as_str() == Some(wanted.as_str()))
        }
        _ => false,
    }
}

fn holds_fold_marks(settings: &Map, wanted: Option<bool>) -> bool {
    match settings.get("foldMarks") {
        None => wanted.is_none(),
        Some(Value::Bool(fold_marks)) => wanted == Some(*fold_marks),
        Some(_) => false,
    }
}

pub(super) fn renews_epoch(settings: &Map, pending: &PendingAnalysis) -> bool {
    let holds_terms = holds_text(settings, "language", Some(&pending.language))
        && holds_text(settings, "tokenizer", pending.tokenizer.as_deref())
        && holds_text(settings, "stopWords", pending.stop_words.as_deref())
        && holds_word_list(settings, pending.stop_word_list.as_deref());
    let captures_history =
        history_enabled(settings, "sync") || history_enabled(settings, "changes");
    captures_history && (!holds_terms || holds_fold_marks(settings, pending.fold_marks))
}
