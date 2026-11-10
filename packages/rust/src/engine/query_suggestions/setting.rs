use super::constants as limits;
use super::phrase::{PhraseLimits, is_group, utf16_length};
use super::schedule::{parse_schedule, time_zone_named};
use super::types::{QuerySuggestionsSetting, QuerySuggestionsSource};
use crate::engine::index_lifecycle::constants::MAX_SAFE_INTEGER;
use crate::error::Result;
use crate::format::metadata_parts::{config_invalid, whole_number};
use crate::schema::{BaseType, CompiledSchema};
use crate::value::{Map, Value, encode_value};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ResolvedSetting {
    pub(crate) enabled: bool,
    pub(crate) fields: Vec<String>,
    pub(crate) min_people: u32,
    pub(crate) min_results: u32,
    pub(crate) retention_days: u32,
    pub(crate) max_phrases_per_day: u32,
    pub(crate) max_phrases_per_person: u32,
    pub(crate) max_people_per_day: u32,
    pub(crate) max_groups: u32,
    pub(crate) min_letters: u32,
    pub(crate) max_length: u32,
    pub(crate) max_words: u32,
    pub(crate) max_digits: u32,
    pub(crate) max_merge_phrases: u32,
    pub(crate) merge_memory_bytes: u64,
    pub(crate) save_interval_ms: u32,
    pub(crate) result_checks_per_second: u32,
    pub(crate) schedule: String,
    pub(crate) time_zone: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum KeyCase {
    Snake,
    Camel,
}

impl KeyCase {
    fn time_zone_key(self) -> &'static str {
        match self {
            KeyCase::Snake => "time_zone",
            KeyCase::Camel => "timeZone",
        }
    }
}

enum Bound {
    Fixed(u64),
    MaxLength,
}

struct Range {
    key: &'static str,
    wire: &'static str,
    get: fn(&QuerySuggestionsSetting) -> Option<u64>,
    set: fn(&mut QuerySuggestionsSetting, u64) -> Option<()>,
    fallback: u64,
    min: u64,
    max: Bound,
}

impl Range {
    fn name(&self, case: KeyCase) -> &'static str {
        match case {
            KeyCase::Snake => self.wire,
            KeyCase::Camel => self.key,
        }
    }

    fn value_of(&self, setting: &QuerySuggestionsSetting) -> u64 {
        (self.get)(setting).unwrap_or(self.fallback)
    }
}

macro_rules! numeric_limits {
    (@min $min:literal) => { $min };
    (@min $min:ident) => { limits::$min as u64 };
    (@max max_length) => { Bound::MaxLength };
    (@max $max:ident) => { Bound::Fixed(limits::$max as u64) };
    ($($field:ident $key:literal: $fallback:ident, $min:tt..=$max:ident;)+) => {
        const RANGES: &[Range] = &[$(Range {
            key: $key,
            wire: stringify!($field),
            get: |setting| setting.$field.map(u64::from),
            set: |setting, value| {
                setting.$field = Some(value.try_into().ok()?);
                Some(())
            },
            fallback: limits::$fallback as u64,
            min: numeric_limits!(@min $min),
            max: numeric_limits!(@max $max),
        },)+];

        impl QuerySuggestionsSetting {
            pub(crate) fn resolve(&self) -> ResolvedSetting {
                let text = |given: &Option<String>, fallback: &str| {
                    given.clone().unwrap_or_else(|| fallback.to_string())
                };
                ResolvedSetting {
                    enabled: self.enabled,
                    fields: self.fields.clone(),
                    schedule: text(&self.schedule, limits::DEFAULT_SCHEDULE),
                    time_zone: text(&self.time_zone, limits::DEFAULT_TIME_ZONE),
                    $($field: self.$field.unwrap_or(limits::$fallback),)+
                }
            }
        }
    };
}

numeric_limits! {
    min_people "minPeople": DEFAULT_MIN_PEOPLE, MIN_MIN_PEOPLE..=MAX_MIN_PEOPLE;
    min_results "minResults": DEFAULT_MIN_RESULTS, MIN_MIN_RESULTS..=MAX_MIN_RESULTS;
    retention_days "retentionDays": DEFAULT_RETENTION_DAYS, MIN_RETENTION_DAYS..=MAX_RETENTION_DAYS;
    max_phrases_per_day "maxPhrasesPerDay": DEFAULT_MAX_PHRASES_PER_DAY, 1..=MAX_MAX_PHRASES_PER_DAY;
    max_phrases_per_person "maxPhrasesPerPerson": DEFAULT_MAX_PHRASES_PER_PERSON, 1..=MAX_MAX_PHRASES_PER_PERSON;
    max_people_per_day "maxPeoplePerDay": DEFAULT_MAX_PEOPLE_PER_DAY, 1..=MAX_MAX_PEOPLE_PER_DAY;
    max_groups "maxGroups": DEFAULT_MAX_GROUPS, 1..=MAX_MAX_GROUPS;
    max_length "maxLength": DEFAULT_MAX_LENGTH, 1..=MAX_MAX_LENGTH;
    min_letters "minLetters": DEFAULT_MIN_LETTERS, 1..=max_length;
    max_words "maxWords": DEFAULT_MAX_WORDS, 1..=MAX_MAX_WORDS;
    max_digits "maxDigits": DEFAULT_MAX_DIGITS, 0..=max_length;
    max_merge_phrases "maxMergePhrases": DEFAULT_MAX_MERGE_PHRASES, 1..=MAX_MAX_MERGE_PHRASES;
    merge_memory_bytes "mergeMemoryBytes": DEFAULT_MERGE_MEMORY_BYTES, MIN_MERGE_MEMORY_BYTES..=MAX_MERGE_MEMORY_BYTES;
    save_interval_ms "saveIntervalMs": DEFAULT_SAVE_INTERVAL_MS, MIN_SAVE_INTERVAL_MS..=MAX_SAVE_INTERVAL_MS;
    result_checks_per_second "resultChecksPerSecond": DEFAULT_RESULT_CHECKS_PER_SECOND, 1..=MAX_RESULT_CHECKS_PER_SECOND;
}

impl ResolvedSetting {
    pub(crate) fn phrase_limits(&self) -> PhraseLimits {
        PhraseLimits {
            min_letters: self.min_letters,
            max_length: self.max_length,
            max_words: self.max_words,
            max_digits: self.max_digits,
        }
    }
}

fn require_products(resolved: &ResolvedSetting) -> Result<()> {
    let products = [
        (
            "maxPeoplePerDay times maxPhrasesPerPerson",
            resolved.max_people_per_day,
            resolved.max_phrases_per_person,
            limits::MAX_PERSON_PAIRS_PER_DAY,
        ),
        (
            "maxPhrasesPerDay times minPeople",
            resolved.max_phrases_per_day,
            resolved.min_people,
            limits::MAX_FILE_PEOPLE_PER_DAY,
        ),
        (
            "maxMergePhrases times minPeople",
            resolved.max_merge_phrases,
            resolved.min_people,
            limits::MAX_MERGE_PEOPLE,
        ),
    ];
    for (product, left, right, ceiling) in products {
        if u64::from(left) * u64::from(right) > ceiling {
            return Err(config_invalid(format!(
                "{product} must stay at or below {ceiling}"
            )));
        }
    }
    Ok(())
}

fn require_fields(fields: &[String]) -> Result<()> {
    if fields.is_empty() || fields.len() > limits::MAX_FIELDS {
        return Err(config_invalid(format!(
            "The query suggestions setting needs from 1 to {} fields",
            limits::MAX_FIELDS
        )));
    }
    for (at, field) in fields.iter().enumerate() {
        if field.is_empty() || fields[..at].contains(field) {
            return Err(config_invalid(
                "Each field of the query suggestions setting must be a distinct, non-empty path",
            ));
        }
    }
    Ok(())
}

pub(crate) fn validate_setting(setting: &QuerySuggestionsSetting) -> Result<()> {
    require_fields(&setting.fields)?;
    let resolved = setting.resolve();
    for range in RANGES {
        let value = range.value_of(setting);
        let max = match range.max {
            Bound::Fixed(max) => max,
            Bound::MaxLength => u64::from(resolved.max_length),
        };
        if value < range.min || value > max {
            return Err(config_invalid(format!(
                "{} must be from {} to {max}, got {value}",
                range.key, range.min
            )));
        }
    }
    require_products(&resolved)?;
    if let Some(schedule) = &setting.schedule
        && schedule != limits::SCHEDULE_OFF
        && parse_schedule(schedule).is_none()
    {
        return Err(config_invalid(format!(
            "schedule must be \"off\" or a cron expression of five fields, got \"{}\"",
            schedule.escape_debug()
        )));
    }
    if let Some(time_zone) = &setting.time_zone
        && time_zone_named(time_zone).is_none()
    {
        return Err(config_invalid(format!(
            "timeZone must name an IANA time zone, got \"{}\"",
            time_zone.escape_debug()
        )));
    }
    let encoded = encode_value(&setting_to_wire(setting, KeyCase::Snake));
    if encoded.map_or(usize::MAX, |bytes| bytes.len()) > limits::MAX_SETTING_BYTES {
        return Err(config_invalid(format!(
            "The query suggestions setting must encode to at most {} bytes",
            limits::MAX_SETTING_BYTES
        )));
    }
    Ok(())
}

pub(crate) fn require_fields_in_schema(
    setting: &QuerySuggestionsSetting,
    schema: &CompiledSchema,
) -> Result<()> {
    for field in &setting.fields {
        let base = schema
            .fields
            .iter()
            .find(|candidate| candidate.path == *field)
            .map(|found| found.field_type.base);
        if !matches!(base, Some(BaseType::String | BaseType::StringList)) {
            return Err(config_invalid(format!(
                "Field \"{field}\" must be a string or string[] field of the schema"
            )));
        }
    }
    Ok(())
}

pub(crate) fn setting_to_wire(setting: &QuerySuggestionsSetting, case: KeyCase) -> Value {
    let mut wire = Map::new();
    wire.insert("enabled", Value::Bool(setting.enabled));
    wire.insert(
        "fields",
        Value::Array(setting.fields.iter().cloned().map(Value::String).collect()),
    );
    for range in RANGES {
        if let Some(value) = (range.get)(setting) {
            wire.insert(range.name(case), Value::Number(value as f64));
        }
    }
    if let Some(schedule) = &setting.schedule {
        wire.insert("schedule", Value::String(schedule.clone()));
    }
    if let Some(time_zone) = &setting.time_zone {
        wire.insert(case.time_zone_key(), Value::String(time_zone.clone()));
    }
    Value::Object(wire)
}

fn limit_of(value: &Value, key: &str) -> Result<u64> {
    let number = whole_number(Some(value))
        .filter(|number| number.abs() <= MAX_SAFE_INTEGER as f64)
        .ok_or_else(|| config_invalid(format!("{key} must be a whole number")))?;
    if number < 0.0 {
        return Err(config_invalid(format!(
            "{key} must not be negative, got {number}"
        )));
    }
    Ok(number as u64)
}

fn fields_of(value: Option<&Value>) -> Result<Vec<String>> {
    let Some(Value::Array(items)) = value else {
        return Err(config_invalid(
            "The query suggestions setting needs an array of fields",
        ));
    };
    items
        .iter()
        .map(|item| match item {
            Value::String(text) => Ok(text.clone()),
            _ => Err(config_invalid(
                "Each field of the query suggestions setting must be a distinct, non-empty path",
            )),
        })
        .collect()
}

fn text_of(value: &Value, key: &str) -> Result<String> {
    match value {
        Value::String(text) => Ok(text.clone()),
        _ => Err(config_invalid(format!("{key} must be a string"))),
    }
}

pub(crate) fn setting_from_wire(raw: &Value, case: KeyCase) -> Result<QuerySuggestionsSetting> {
    let Value::Object(wire) = raw else {
        return Err(config_invalid(
            "The stored query suggestions setting is not a map",
        ));
    };
    let mut setting = QuerySuggestionsSetting::default();
    for (key, value) in wire.iter() {
        if key == "enabled" || key == "fields" {
            continue;
        }
        if key == "schedule" {
            setting.schedule = Some(text_of(value, "schedule")?);
        } else if key == case.time_zone_key() {
            setting.time_zone = Some(text_of(value, "timeZone")?);
        } else if let Some(range) = RANGES.iter().find(|range| range.name(case) == key) {
            let number = limit_of(value, range.key)?;
            (range.set)(&mut setting, number).ok_or_else(|| {
                config_invalid(format!("{} is out of range, got {number}", range.key))
            })?;
        } else {
            return Err(config_invalid(format!(
                "The stored query suggestions setting holds an unknown key \"{}\"",
                key.escape_debug()
            )));
        }
    }
    setting.enabled = match wire.get("enabled") {
        Some(Value::Bool(enabled)) => *enabled,
        _ => {
            return Err(config_invalid(
                "The query suggestions setting needs a boolean \"enabled\"",
            ));
        }
    };
    setting.fields = fields_of(wire.get("fields"))?;
    validate_setting(&setting)?;
    Ok(setting)
}

pub(crate) fn source_to_wire(source: &QuerySuggestionsSource) -> Value {
    let mut wire = Map::new();
    wire.insert("index", Value::String(source.index.clone()));
    wire.insert("group", Value::String(source.group.clone()));
    Value::Object(wire)
}

pub(crate) fn source_from_wire(raw: &Value) -> Result<QuerySuggestionsSource> {
    let Value::Object(wire) = raw else {
        return Err(config_invalid("The suggestions index marker must be a map"));
    };
    if wire.keys().any(|key| key != "index" && key != "group") {
        return Err(config_invalid(
            "The suggestions index marker holds an unknown key",
        ));
    }
    let index = match wire.get("index") {
        Some(Value::String(index))
            if !index.is_empty() && utf16_length(index) <= limits::MAX_SOURCE_INDEX_NAME_LENGTH =>
        {
            index.clone()
        }
        _ => {
            return Err(config_invalid(
                "The suggestions index marker needs the name of its source index",
            ));
        }
    };
    let group = match wire.get("group") {
        Some(Value::String(group)) if is_group(group) => group.clone(),
        _ => {
            return Err(config_invalid(
                "The suggestions index marker needs a valid group",
            ));
        }
    };
    Ok(QuerySuggestionsSource { index, group })
}
