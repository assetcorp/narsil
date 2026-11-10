use super::constants as limits;
use super::phrase::PhraseLimits;
use super::schedule::{parse_schedule, time_zone_named};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::schema::BaseType;

/// The popular query suggestions setting of one index. Only `enabled` and `fields` are required, and each limit
/// left at `None` takes its default.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct QuerySuggestionsSetting {
    /// Set this to true to count searches for the index and build its suggestions.
    pub enabled: bool,
    /// The `string` and `string[]` fields whose text a phrase must match before the engine publishes it.
    pub fields: Vec<String>,
    /// The number of people, from 2 to 4,096, who must search a phrase before the engine publishes it. Defaults
    /// to 4.
    pub min_people: Option<u32>,
    /// The number of documents, from 1 to 10,000, that a phrase must match with every word. Defaults to 5.
    pub min_results: Option<u32>,
    /// The number of days, from 1 to 365, that the engine keeps the counts of a day. Defaults to 30.
    pub retention_days: Option<u32>,
    /// The number of phrases, up to 16,384, that the engine counts for the index each day. Defaults to 10,000.
    pub max_phrases_per_day: Option<u32>,
    /// The number of phrases, up to 1,000, that the engine counts for one person each day. Defaults to 100.
    pub max_phrases_per_person: Option<u32>,
    /// The number of people, up to 100,000, that the engine counts for the index each day. Defaults to 100,000.
    pub max_people_per_day: Option<u32>,
    /// The number of groups, up to 1,000, that the index counts. Defaults to 100.
    pub max_groups: Option<u32>,
    /// The number of letters that a phrase must hold. Defaults to 4.
    pub min_letters: Option<u32>,
    /// The number of characters, up to 150, that a phrase may hold. Defaults to 100.
    pub max_length: Option<u32>,
    /// The number of words, up to 50, that a phrase may hold. Defaults to 8.
    pub max_words: Option<u32>,
    /// The number of digits that a phrase may hold in total. Defaults to 5.
    pub max_digits: Option<u32>,
    /// The number of phrases, up to 500,000, that one build merges. Defaults to 100,000.
    pub max_merge_phrases: Option<u32>,
    /// The memory, from 16 MiB to 1 GiB, that a build's merge may hold. Defaults to 128 MiB.
    pub merge_memory_bytes: Option<u64>,
    /// How often, from 1 second to 1 hour, the engine saves the counts of the day. Defaults to 5 minutes.
    pub save_interval_ms: Option<u32>,
    /// The number of result checks, up to 1,000, that a build runs each second. Defaults to 20.
    pub result_checks_per_second: Option<u32>,
    /// A cron expression of five fields, or `off`. Defaults to `0 3 * * *`.
    pub schedule: Option<String>,
    /// The IANA time zone of `schedule`. Defaults to `UTC`.
    pub time_zone: Option<String>,
}

/// A setting with every limit at its value or its default.
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

pub(crate) use super::setting_ranges::{Bound, RANGES, Range};

/// Returns the refusal of a setting, a ban list, or a marker that breaks a rule.
pub(crate) fn invalid_setting(message: impl Into<String>) -> NarsilError {
    NarsilError::new(ErrorCode::CONFIG_INVALID, message)
}

fn value_of(setting: &QuerySuggestionsSetting, range: &Range) -> u64 {
    (range.get)(setting).unwrap_or(range.fallback)
}

fn narrow(value: u64) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

impl QuerySuggestionsSetting {
    pub(crate) fn resolve(&self) -> ResolvedSetting {
        let at = |index: usize| RANGES.get(index).map_or(0, |range| value_of(self, range));
        ResolvedSetting {
            enabled: self.enabled,
            fields: self.fields.clone(),
            min_people: narrow(at(0)),
            min_results: narrow(at(1)),
            retention_days: narrow(at(2)),
            max_phrases_per_day: narrow(at(3)),
            max_phrases_per_person: narrow(at(4)),
            max_people_per_day: narrow(at(5)),
            max_groups: narrow(at(6)),
            max_length: narrow(at(7)),
            min_letters: narrow(at(8)),
            max_words: narrow(at(9)),
            max_digits: narrow(at(10)),
            max_merge_phrases: narrow(at(11)),
            merge_memory_bytes: at(12),
            save_interval_ms: narrow(at(13)),
            result_checks_per_second: narrow(at(14)),
            schedule: self
                .schedule
                .clone()
                .unwrap_or_else(|| limits::DEFAULT_SCHEDULE.to_string()),
            time_zone: self
                .time_zone
                .clone()
                .unwrap_or_else(|| limits::DEFAULT_TIME_ZONE.to_string()),
        }
    }
}

impl ResolvedSetting {
    /// Returns the limits that a phrase must keep within before the engine counts it.
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
    let product = |left: u32, right: u32| u64::from(left) * u64::from(right);
    if product(resolved.max_people_per_day, resolved.max_phrases_per_person)
        > limits::MAX_PERSON_PAIRS_PER_DAY
    {
        return Err(invalid_setting(format!(
            "maxPeoplePerDay times maxPhrasesPerPerson must stay at or below {}",
            limits::MAX_PERSON_PAIRS_PER_DAY
        )));
    }
    if product(resolved.max_phrases_per_day, resolved.min_people) > limits::MAX_FILE_PEOPLE_PER_DAY
    {
        return Err(invalid_setting(format!(
            "maxPhrasesPerDay times minPeople must stay at or below {}",
            limits::MAX_FILE_PEOPLE_PER_DAY
        )));
    }
    if product(resolved.max_merge_phrases, resolved.min_people) > limits::MAX_MERGE_PEOPLE {
        return Err(invalid_setting(format!(
            "maxMergePhrases times minPeople must stay at or below {}",
            limits::MAX_MERGE_PEOPLE
        )));
    }
    Ok(())
}

fn require_fields(fields: &[String]) -> Result<()> {
    if fields.is_empty() || fields.len() > limits::MAX_FIELDS {
        return Err(invalid_setting(format!(
            "The query suggestions setting needs from 1 to {} fields",
            limits::MAX_FIELDS
        )));
    }
    for (at, field) in fields.iter().enumerate() {
        if field.is_empty() || fields[..at].contains(field) {
            return Err(invalid_setting(
                "Each field of the query suggestions setting must be a distinct, non-empty path",
            ));
        }
    }
    Ok(())
}

/// Checks a setting against every rule of the specification that holds without the index's schema.
pub(crate) fn validate_setting(setting: &QuerySuggestionsSetting) -> Result<()> {
    require_fields(&setting.fields)?;
    for range in &RANGES {
        let value = value_of(setting, range);
        let max = match range.max {
            Bound::Fixed(max) => max,
            Bound::MaxLength => RANGES.get(7).map_or(0, |length| value_of(setting, length)),
        };
        if value < range.min || value > max {
            return Err(invalid_setting(format!(
                "{} must be from {} to {max}, got {value}",
                range.key, range.min
            )));
        }
    }
    require_products(&setting.resolve())?;
    if let Some(schedule) = &setting.schedule
        && schedule != limits::SCHEDULE_OFF
        && parse_schedule(schedule).is_none()
    {
        return Err(invalid_setting(format!(
            "schedule must be \"off\" or a cron expression of five fields, got \"{}\"",
            schedule.escape_debug()
        )));
    }
    if let Some(time_zone) = &setting.time_zone
        && time_zone_named(time_zone).is_none()
    {
        return Err(invalid_setting(format!(
            "timeZone must name an IANA time zone, got \"{}\"",
            time_zone.escape_debug()
        )));
    }
    let encoded = super::setting_wire::setting_wire_bytes(setting);
    if encoded > limits::MAX_SETTING_BYTES {
        return Err(invalid_setting(format!(
            "The query suggestions setting must encode to at most {} bytes",
            limits::MAX_SETTING_BYTES
        )));
    }
    Ok(())
}

/// Refuses a setting whose fields are not `string` or `string[]` fields of `schema`.
pub(crate) fn require_fields_in_schema(
    setting: &QuerySuggestionsSetting,
    schema: &crate::schema::CompiledSchema,
) -> Result<()> {
    for field in &setting.fields {
        let base = schema
            .fields
            .iter()
            .find(|candidate| candidate.path == *field)
            .map(|found| found.field_type.base);
        if !matches!(base, Some(BaseType::String | BaseType::StringList)) {
            return Err(invalid_setting(format!(
                "Field \"{field}\" must be a string or string[] field of the schema"
            )));
        }
    }
    Ok(())
}
