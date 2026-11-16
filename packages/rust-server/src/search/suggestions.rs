use narsil::{
    Map, QuerySuggestionsBuild, QuerySuggestionsPreview, QuerySuggestionsSetting,
    QuerySuggestionsStatus, RecordQueryResult, Value,
};

fn whole(value: u64) -> Value {
    Value::Number(value as f64)
}

fn strings(items: Vec<String>) -> Value {
    Value::Array(items.into_iter().map(Value::String).collect())
}

fn setting_value(setting: QuerySuggestionsSetting) -> Value {
    let limits = [
        ("minPeople", setting.min_people),
        ("minResults", setting.min_results),
        ("retentionDays", setting.retention_days),
        ("maxPhrasesPerDay", setting.max_phrases_per_day),
        ("maxPhrasesPerPerson", setting.max_phrases_per_person),
        ("maxPeoplePerDay", setting.max_people_per_day),
        ("maxGroups", setting.max_groups),
        ("maxLength", setting.max_length),
        ("minLetters", setting.min_letters),
        ("maxWords", setting.max_words),
        ("maxDigits", setting.max_digits),
        ("maxMergePhrases", setting.max_merge_phrases),
    ];
    let mut map = Map::with_capacity(limits.len() + 7);
    map.insert("enabled", Value::Bool(setting.enabled));
    map.insert("fields", strings(setting.fields));
    for (key, limit) in limits {
        if let Some(limit) = limit {
            map.insert(key, whole(u64::from(limit)));
        }
    }
    if let Some(bytes) = setting.merge_memory_bytes {
        map.insert("mergeMemoryBytes", whole(bytes));
    }
    if let Some(interval) = setting.save_interval_ms {
        map.insert("saveIntervalMs", whole(u64::from(interval)));
    }
    if let Some(checks) = setting.result_checks_per_second {
        map.insert("resultChecksPerSecond", whole(u64::from(checks)));
    }
    if let Some(schedule) = setting.schedule {
        map.insert("schedule", Value::String(schedule));
    }
    if let Some(time_zone) = setting.time_zone {
        map.insert("timeZone", Value::String(time_zone));
    }
    Value::Object(map)
}

fn build_value(build: QuerySuggestionsBuild) -> Value {
    let mut map = Map::with_capacity(9);
    map.insert("buildId", Value::String(build.build_id));
    map.insert("trigger", Value::String(build.trigger.as_str().to_string()));
    map.insert("status", Value::String(build.status.as_str().to_string()));
    map.insert("startedAt", whole(build.started_at));
    map.insert("endedAt", build.ended_at.map_or(Value::Null, whole));
    map.insert("published", whole(build.published));
    map.insert("removed", whole(build.removed));
    map.insert("discarded", whole(build.discarded));
    map.insert(
        "errorCode",
        build.error_code.map_or(Value::Null, Value::String),
    );
    Value::Object(map)
}

pub(crate) fn status_value(status: QuerySuggestionsStatus) -> Value {
    let mut map = Map::with_capacity(5);
    map.insert("indexName", Value::String(status.index_name));
    map.insert("setting", status.setting.map_or(Value::Null, setting_value));
    map.insert(
        "lastBuild",
        status.last_build.map_or(Value::Null, build_value),
    );
    map.insert(
        "nextBuildAt",
        status
            .next_build_at
            .map_or(Value::Null, |at| Value::Number(at as f64)),
    );
    map.insert("suggestionIndexes", strings(status.suggestion_indexes));
    Value::Object(map)
}

pub(crate) fn preview_value(preview: QuerySuggestionsPreview) -> Value {
    let entries = preview
        .entries
        .into_iter()
        .map(|entry| {
            let mut map = Map::with_capacity(3);
            map.insert("group", Value::String(entry.group));
            map.insert("query", Value::String(entry.query));
            map.insert("count", whole(entry.count));
            Value::Object(map)
        })
        .collect();
    let mut map = Map::with_capacity(2);
    map.insert("entries", Value::Array(entries));
    map.insert("truncated", Value::Bool(preview.truncated));
    Value::Object(map)
}

pub(crate) fn recorded_value(result: RecordQueryResult) -> Value {
    let mut map = Map::with_capacity(2);
    map.insert("recorded", Value::Bool(result.recorded));
    map.insert(
        "outcome",
        Value::String(result.outcome.as_str().to_string()),
    );
    Value::Object(map)
}

pub(crate) fn bans_value(bans: Vec<String>) -> Value {
    let mut map = Map::with_capacity(1);
    map.insert("bans", strings(bans));
    Value::Object(map)
}
