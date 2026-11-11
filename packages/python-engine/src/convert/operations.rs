use narsil::{
    AnalysisChange, AnalysisSetting, ErrorCode, ListParams, ManualQuerySuggestion, NarsilError,
    QuerySuggestionsBuild, QuerySuggestionsPreview, QuerySuggestionsSetting,
    QuerySuggestionsStatus, RecordQueryResult, RecordedQuery, SuggestParams, SyncSetting,
};
use pyo3::prelude::*;
use pyo3::types::{PyDict, PyList, PyString};

use super::fields::{Fields, string_of};
use super::query::{filter_value, projection};
use crate::callbacks::analysis::stop_words_setting;
use crate::errors::{config_invalid, recoded};

const SUGGESTION_KEYS_REFUSING_NONE: [&str; 17] = [
    "minPeople",
    "minResults",
    "retentionDays",
    "maxPhrasesPerDay",
    "maxPhrasesPerPerson",
    "maxPeoplePerDay",
    "maxGroups",
    "minLetters",
    "maxLength",
    "maxWords",
    "maxDigits",
    "maxMergePhrases",
    "mergeMemoryBytes",
    "saveIntervalMs",
    "resultChecksPerSecond",
    "schedule",
    "timeZone",
];

pub(crate) fn list_params(value: Option<&Bound<'_, PyAny>>) -> Result<ListParams, NarsilError> {
    let Some(value) = value.filter(|value| !value.is_none()) else {
        return Ok(ListParams::default());
    };
    let mut fields = Fields::of(value, "params")?;
    fields.refuse_none("filters", ErrorCode::SEARCH_INVALID_FILTER)?;
    let document_path = fields.path("document");
    let params = ListParams {
        cursor: fields.string("cursor")?,
        limit: fields.size("limit")?,
        filters: filter_value(&mut fields)?,
        document: fields
            .get("document")?
            .map(|document| projection(&document, &document_path))
            .transpose()?,
    };
    fields.finish()?;
    Ok(params)
}

pub(crate) fn suggest_params(value: &Bound<'_, PyAny>) -> Result<SuggestParams, NarsilError> {
    let mut fields = Fields::of(value, "params")?;
    let params = SuggestParams {
        prefix: fields.required_string("prefix")?,
        limit: fields.size("limit")?,
    };
    fields.finish()?;
    Ok(params)
}

pub(crate) fn analysis_change(value: &Bound<'_, PyAny>) -> Result<AnalysisChange, NarsilError> {
    let mut fields = Fields::of(value, "change")?;
    fields.refuse_none("language", ErrorCode::LANGUAGE_NOT_SUPPORTED)?;
    let language = fields
        .string("language")
        .map_err(recoded(ErrorCode::LANGUAGE_NOT_SUPPORTED))?;
    let tokenizer_path = fields.path("tokenizer");
    let tokenizer = match fields.present("tokenizer")? {
        None => AnalysisSetting::Keep,
        Some(tokenizer) if tokenizer.is_none() => AnalysisSetting::LanguageDefault,
        Some(tokenizer) => AnalysisSetting::Set(string_of(&tokenizer, &tokenizer_path)?),
    };
    let stop_words_path = fields.path("stopWords");
    let stop_words = match fields.present("stopWords")? {
        None => AnalysisSetting::Keep,
        Some(stop_words) if stop_words.is_none() => AnalysisSetting::LanguageDefault,
        Some(stop_words) => {
            AnalysisSetting::Set(stop_words_setting(&stop_words, &stop_words_path)?)
        }
    };
    fields.finish()?;
    Ok(AnalysisChange {
        language,
        tokenizer,
        stop_words,
    })
}

pub(crate) fn sync_setting(value: &Bound<'_, PyAny>) -> Result<SyncSetting, NarsilError> {
    let mut fields = Fields::of(value, "setting")?;
    fields.refuse_each_none(
        &["historyMaxAgeMs", "historyMaxBytes"],
        ErrorCode::CONFIG_INVALID,
    )?;
    let setting = SyncSetting {
        enabled: fields
            .boolean("enabled")?
            .ok_or_else(|| config_invalid("setting.enabled is required"))?,
        history_max_age_ms: fields.whole("historyMaxAgeMs")?,
        history_max_bytes: fields.whole("historyMaxBytes")?,
    };
    fields.finish()?;
    Ok(setting)
}

fn recorded_text(fields: &mut Fields<'_>, key: &'static str) -> Result<String, NarsilError> {
    Ok(fields
        .present(key)?
        .and_then(|value| {
            value
                .cast::<PyString>()
                .ok()
                .map(|text| text.to_string_lossy().into_owned())
        })
        .unwrap_or_default())
}

pub(crate) fn recorded_query(value: &Bound<'_, PyAny>) -> Result<RecordedQuery, NarsilError> {
    let Ok(mut fields) = Fields::of(value, "query") else {
        return Ok(RecordedQuery {
            query: String::new(),
            person: String::new(),
            group: String::new(),
        });
    };
    let query = RecordedQuery {
        query: recorded_text(&mut fields, "query")?,
        person: recorded_text(&mut fields, "person")?,
        group: recorded_text(&mut fields, "group")?,
    };
    fields.finish()?;
    Ok(query)
}

pub(crate) fn manual_suggestion(
    value: &Bound<'_, PyAny>,
) -> Result<ManualQuerySuggestion, NarsilError> {
    let mut fields = Fields::of(value, "suggestion")?;
    fields.refuse_none("count", ErrorCode::CONFIG_INVALID)?;
    let suggestion = ManualQuerySuggestion {
        group: fields.required_string("group")?,
        query: fields.required_string("query")?,
        count: fields.whole("count")?,
    };
    fields.finish()?;
    Ok(suggestion)
}

pub(crate) fn suggestions_setting(
    value: &Bound<'_, PyAny>,
) -> Result<QuerySuggestionsSetting, NarsilError> {
    let mut fields = Fields::of(value, "setting")?;
    fields.refuse_each_none(&SUGGESTION_KEYS_REFUSING_NONE, ErrorCode::CONFIG_INVALID)?;
    let setting = QuerySuggestionsSetting {
        enabled: fields
            .boolean("enabled")?
            .ok_or_else(|| config_invalid("setting.enabled is required"))?,
        fields: fields
            .strings("fields")?
            .ok_or_else(|| config_invalid("setting.fields is required"))?,
        min_people: fields.whole_u32("minPeople")?,
        min_results: fields.whole_u32("minResults")?,
        retention_days: fields.whole_u32("retentionDays")?,
        max_phrases_per_day: fields.whole_u32("maxPhrasesPerDay")?,
        max_phrases_per_person: fields.whole_u32("maxPhrasesPerPerson")?,
        max_people_per_day: fields.whole_u32("maxPeoplePerDay")?,
        max_groups: fields.whole_u32("maxGroups")?,
        min_letters: fields.whole_u32("minLetters")?,
        max_length: fields.whole_u32("maxLength")?,
        max_words: fields.whole_u32("maxWords")?,
        max_digits: fields.whole_u32("maxDigits")?,
        max_merge_phrases: fields.whole_u32("maxMergePhrases")?,
        merge_memory_bytes: fields.whole("mergeMemoryBytes")?,
        save_interval_ms: fields.whole_u32("saveIntervalMs")?,
        result_checks_per_second: fields.whole_u32("resultChecksPerSecond")?,
        schedule: fields.string("schedule")?,
        time_zone: fields.string("timeZone")?,
    };
    fields.finish()?;
    Ok(setting)
}

fn set_some<'py, T: IntoPyObject<'py>>(
    dict: &Bound<'py, PyDict>,
    key: &str,
    value: Option<T>,
) -> PyResult<()> {
    match value {
        Some(value) => dict.set_item(key, value),
        None => Ok(()),
    }
}

fn setting_dict<'py>(
    py: Python<'py>,
    setting: &QuerySuggestionsSetting,
) -> PyResult<Bound<'py, PyDict>> {
    let dict = PyDict::new(py);
    dict.set_item("enabled", setting.enabled)?;
    dict.set_item("fields", setting.fields.clone())?;
    set_some(&dict, "minPeople", setting.min_people)?;
    set_some(&dict, "minResults", setting.min_results)?;
    set_some(&dict, "retentionDays", setting.retention_days)?;
    set_some(&dict, "maxPhrasesPerDay", setting.max_phrases_per_day)?;
    set_some(&dict, "maxPhrasesPerPerson", setting.max_phrases_per_person)?;
    set_some(&dict, "maxPeoplePerDay", setting.max_people_per_day)?;
    set_some(&dict, "maxGroups", setting.max_groups)?;
    set_some(&dict, "minLetters", setting.min_letters)?;
    set_some(&dict, "maxLength", setting.max_length)?;
    set_some(&dict, "maxWords", setting.max_words)?;
    set_some(&dict, "maxDigits", setting.max_digits)?;
    set_some(&dict, "maxMergePhrases", setting.max_merge_phrases)?;
    set_some(&dict, "mergeMemoryBytes", setting.merge_memory_bytes)?;
    set_some(&dict, "saveIntervalMs", setting.save_interval_ms)?;
    set_some(
        &dict,
        "resultChecksPerSecond",
        setting.result_checks_per_second,
    )?;
    set_some(&dict, "schedule", setting.schedule.as_deref())?;
    set_some(&dict, "timeZone", setting.time_zone.as_deref())?;
    Ok(dict)
}

pub(crate) fn build_dict<'py>(
    py: Python<'py>,
    build: &QuerySuggestionsBuild,
) -> PyResult<Bound<'py, PyDict>> {
    let dict = PyDict::new(py);
    dict.set_item("buildId", &build.build_id)?;
    dict.set_item("trigger", build.trigger.as_str())?;
    dict.set_item("status", build.status.as_str())?;
    dict.set_item("startedAt", build.started_at)?;
    dict.set_item("endedAt", build.ended_at)?;
    dict.set_item("published", build.published)?;
    dict.set_item("removed", build.removed)?;
    dict.set_item("discarded", build.discarded)?;
    dict.set_item("errorCode", build.error_code.as_deref())?;
    Ok(dict)
}

pub(crate) fn status_dict<'py>(
    py: Python<'py>,
    status: &QuerySuggestionsStatus,
) -> PyResult<Bound<'py, PyDict>> {
    let dict = PyDict::new(py);
    dict.set_item("indexName", &status.index_name)?;
    let setting = status
        .setting
        .as_ref()
        .map(|setting| setting_dict(py, setting))
        .transpose()?;
    dict.set_item("setting", setting)?;
    let last_build = status
        .last_build
        .as_ref()
        .map(|build| build_dict(py, build))
        .transpose()?;
    dict.set_item("lastBuild", last_build)?;
    dict.set_item("nextBuildAt", status.next_build_at)?;
    dict.set_item("suggestionIndexes", status.suggestion_indexes.clone())?;
    Ok(dict)
}

pub(crate) fn preview_dict<'py>(
    py: Python<'py>,
    preview: &QuerySuggestionsPreview,
) -> PyResult<Bound<'py, PyDict>> {
    let dict = PyDict::new(py);
    let entries = PyList::empty(py);
    for entry in &preview.entries {
        let item = PyDict::new(py);
        item.set_item("group", &entry.group)?;
        item.set_item("query", &entry.query)?;
        item.set_item("count", entry.count)?;
        entries.append(item)?;
    }
    dict.set_item("entries", entries)?;
    dict.set_item("truncated", preview.truncated)?;
    Ok(dict)
}

pub(crate) fn record_dict<'py>(
    py: Python<'py>,
    result: &RecordQueryResult,
) -> PyResult<Bound<'py, PyDict>> {
    let dict = PyDict::new(py);
    dict.set_item("recorded", result.recorded)?;
    dict.set_item("outcome", result.outcome.as_str())?;
    Ok(dict)
}
