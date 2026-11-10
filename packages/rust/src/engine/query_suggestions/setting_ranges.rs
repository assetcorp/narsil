use super::constants as limits;
use super::setting::QuerySuggestionsSetting;

/// The upper end of a numeric limit: a fixed value, or the `maxLength` of the same setting.
#[derive(Clone, Copy)]
pub(crate) enum Bound {
    Fixed(u64),
    MaxLength,
}

/// One numeric limit of the setting: its camelCase and snake_case names, where it lives, and its range.
pub(crate) struct Range {
    pub(crate) key: &'static str,
    pub(crate) wire: &'static str,
    pub(crate) get: fn(&QuerySuggestionsSetting) -> Option<u64>,
    pub(crate) set: fn(&mut QuerySuggestionsSetting, u64),
    pub(crate) fallback: u64,
    pub(crate) min: u64,
    pub(crate) max: Bound,
}

macro_rules! range {
    ($key:literal, $wire:literal, $field:ident, u32, $fallback:expr, $min:expr, $max:expr) => {
        Range {
            key: $key,
            wire: $wire,
            get: |setting| setting.$field.map(u64::from),
            set: |setting, value| setting.$field = u32::try_from(value).ok(),
            fallback: $fallback as u64,
            min: $min as u64,
            max: $max,
        }
    };
    ($key:literal, $wire:literal, $field:ident, u64, $fallback:expr, $min:expr, $max:expr) => {
        Range {
            key: $key,
            wire: $wire,
            get: |setting| setting.$field,
            set: |setting, value| setting.$field = Some(value),
            fallback: $fallback,
            min: $min,
            max: $max,
        }
    };
}

/// The numeric limits in the order that every Narsil engine checks and writes them.
pub(crate) const RANGES: [Range; 15] = [
    range!(
        "minPeople",
        "min_people",
        min_people,
        u32,
        limits::DEFAULT_MIN_PEOPLE,
        limits::MIN_MIN_PEOPLE,
        Bound::Fixed(limits::MAX_MIN_PEOPLE as u64)
    ),
    range!(
        "minResults",
        "min_results",
        min_results,
        u32,
        limits::DEFAULT_MIN_RESULTS,
        limits::MIN_MIN_RESULTS,
        Bound::Fixed(limits::MAX_MIN_RESULTS as u64)
    ),
    range!(
        "retentionDays",
        "retention_days",
        retention_days,
        u32,
        limits::DEFAULT_RETENTION_DAYS,
        limits::MIN_RETENTION_DAYS,
        Bound::Fixed(limits::MAX_RETENTION_DAYS as u64)
    ),
    range!(
        "maxPhrasesPerDay",
        "max_phrases_per_day",
        max_phrases_per_day,
        u32,
        limits::DEFAULT_MAX_PHRASES_PER_DAY,
        1,
        Bound::Fixed(limits::MAX_MAX_PHRASES_PER_DAY as u64)
    ),
    range!(
        "maxPhrasesPerPerson",
        "max_phrases_per_person",
        max_phrases_per_person,
        u32,
        limits::DEFAULT_MAX_PHRASES_PER_PERSON,
        1,
        Bound::Fixed(limits::MAX_MAX_PHRASES_PER_PERSON as u64)
    ),
    range!(
        "maxPeoplePerDay",
        "max_people_per_day",
        max_people_per_day,
        u32,
        limits::DEFAULT_MAX_PEOPLE_PER_DAY,
        1,
        Bound::Fixed(limits::MAX_MAX_PEOPLE_PER_DAY as u64)
    ),
    range!(
        "maxGroups",
        "max_groups",
        max_groups,
        u32,
        limits::DEFAULT_MAX_GROUPS,
        1,
        Bound::Fixed(limits::MAX_MAX_GROUPS as u64)
    ),
    range!(
        "maxLength",
        "max_length",
        max_length,
        u32,
        limits::DEFAULT_MAX_LENGTH,
        1,
        Bound::Fixed(limits::MAX_MAX_LENGTH as u64)
    ),
    range!(
        "minLetters",
        "min_letters",
        min_letters,
        u32,
        limits::DEFAULT_MIN_LETTERS,
        1,
        Bound::MaxLength
    ),
    range!(
        "maxWords",
        "max_words",
        max_words,
        u32,
        limits::DEFAULT_MAX_WORDS,
        1,
        Bound::Fixed(limits::MAX_MAX_WORDS as u64)
    ),
    range!(
        "maxDigits",
        "max_digits",
        max_digits,
        u32,
        limits::DEFAULT_MAX_DIGITS,
        0,
        Bound::MaxLength
    ),
    range!(
        "maxMergePhrases",
        "max_merge_phrases",
        max_merge_phrases,
        u32,
        limits::DEFAULT_MAX_MERGE_PHRASES,
        1,
        Bound::Fixed(limits::MAX_MAX_MERGE_PHRASES as u64)
    ),
    range!(
        "mergeMemoryBytes",
        "merge_memory_bytes",
        merge_memory_bytes,
        u64,
        limits::DEFAULT_MERGE_MEMORY_BYTES,
        limits::MIN_MERGE_MEMORY_BYTES,
        Bound::Fixed(limits::MAX_MERGE_MEMORY_BYTES)
    ),
    range!(
        "saveIntervalMs",
        "save_interval_ms",
        save_interval_ms,
        u32,
        limits::DEFAULT_SAVE_INTERVAL_MS,
        limits::MIN_SAVE_INTERVAL_MS,
        Bound::Fixed(limits::MAX_SAVE_INTERVAL_MS as u64)
    ),
    range!(
        "resultChecksPerSecond",
        "result_checks_per_second",
        result_checks_per_second,
        u32,
        limits::DEFAULT_RESULT_CHECKS_PER_SECOND,
        1,
        Bound::Fixed(limits::MAX_RESULT_CHECKS_PER_SECOND as u64)
    ),
];
