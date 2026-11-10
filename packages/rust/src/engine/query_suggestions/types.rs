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

/// The index and the group that a suggestions index serves.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct QuerySuggestionsSource {
    /// The index whose searches the suggestions come from.
    pub index: String,
    /// The group whose searches the suggestions come from.
    pub group: String,
}

/// The engine-wide setting of popular query suggestions, which [`crate::NarsilConfig`] carries.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct QuerySuggestionsConfig {
    /// The secret key, at least 32 bytes long, that scrambles the ID of each person before the engine stores it.
    ///
    /// Keep the key secret and keep it the same across restarts, because the engine skips each history file that
    /// another key scrambled. [`crate::Narsil::open`] fails with `CONFIG_INVALID` for a shorter key.
    pub key: Vec<u8>,
}

impl std::fmt::Debug for QuerySuggestionsConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("QuerySuggestionsConfig")
            .field("key_bytes", &self.key.len())
            .finish()
    }
}

/// One search that a person followed with a click, which [`QuerySuggestions::record_query`] counts.
///
/// [`QuerySuggestions::record_query`]: super::QuerySuggestions::record_query
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordedQuery {
    /// The text that the person searched for.
    pub query: String,
    /// The ID of the person, from 1 to 256 UTF-16 code units, which the engine scrambles before it stores it.
    pub person: String,
    /// The group of people whose suggestions the search counts towards, matching `[A-Za-z0-9][A-Za-z0-9_-]{0,31}`.
    pub group: String,
}

/// What counting one search did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum RecordQueryOutcome {
    /// The engine counted the search.
    Recorded,
    /// The person searched the phrase earlier that day, so the engine counted it once.
    Repeat,
    /// The phrase, the person, or the group breaks a rule of the setting.
    Invalid,
    /// The ban list of the index holds the phrase.
    Banned,
    /// The person searched as many phrases that day as `maxPhrasesPerPerson` allows.
    PersonLimit,
    /// The day holds as many phrases as `maxPhrasesPerDay` allows.
    PhraseLimit,
    /// The day counted as many people as `maxPeoplePerDay` allows.
    PeopleLimit,
    /// The group would be a new one while the index holds as many as `maxGroups` allows.
    GroupLimit,
    /// The engine has no query suggestions key, so it counts nothing.
    NoKey,
    /// The search came without the ID of a person.
    Unidentified,
}

impl RecordQueryOutcome {
    /// Returns the outcome as every Narsil implementation spells it, such as `person-limit`.
    pub fn as_str(self) -> &'static str {
        match self {
            RecordQueryOutcome::Recorded => "recorded",
            RecordQueryOutcome::Repeat => "repeat",
            RecordQueryOutcome::Invalid => "invalid",
            RecordQueryOutcome::Banned => "banned",
            RecordQueryOutcome::PersonLimit => "person-limit",
            RecordQueryOutcome::PhraseLimit => "phrase-limit",
            RecordQueryOutcome::PeopleLimit => "people-limit",
            RecordQueryOutcome::GroupLimit => "group-limit",
            RecordQueryOutcome::NoKey => "no-key",
            RecordQueryOutcome::Unidentified => "unidentified",
        }
    }
}

/// The result of counting one search.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecordQueryResult {
    /// Whether the engine counted the search.
    pub recorded: bool,
    /// What counting the search did.
    pub outcome: RecordQueryOutcome,
}

/// What started a build of suggestions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum QuerySuggestionsBuildTrigger {
    /// The schedule of the setting came due.
    Schedule,
    /// The engine started with a scheduled build that it missed while it was down.
    Missed,
    /// A caller asked for the build through [`QuerySuggestions::build`].
    ///
    /// [`QuerySuggestions::build`]: super::QuerySuggestions::build
    Caller,
}

impl QuerySuggestionsBuildTrigger {
    /// Returns the trigger as every Narsil implementation spells it.
    pub fn as_str(self) -> &'static str {
        match self {
            QuerySuggestionsBuildTrigger::Schedule => "schedule",
            QuerySuggestionsBuildTrigger::Missed => "missed",
            QuerySuggestionsBuildTrigger::Caller => "caller",
        }
    }

    pub(crate) fn named(name: &str) -> Option<QuerySuggestionsBuildTrigger> {
        [Self::Schedule, Self::Missed, Self::Caller]
            .into_iter()
            .find(|trigger| trigger.as_str() == name)
    }
}

/// The stage that a build has reached.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum QuerySuggestionsBuildStatus {
    /// The build is under way.
    Running,
    /// The build wrote its suggestions.
    Completed,
    /// The build stopped with an error and undid what it wrote.
    Failed,
    /// The build found nothing new to merge, or another build of the index was under way.
    Skipped,
}

impl QuerySuggestionsBuildStatus {
    /// Returns the status as every Narsil implementation spells it.
    pub fn as_str(self) -> &'static str {
        match self {
            QuerySuggestionsBuildStatus::Running => "running",
            QuerySuggestionsBuildStatus::Completed => "completed",
            QuerySuggestionsBuildStatus::Failed => "failed",
            QuerySuggestionsBuildStatus::Skipped => "skipped",
        }
    }

    pub(crate) fn named(name: &str) -> Option<QuerySuggestionsBuildStatus> {
        [Self::Running, Self::Completed, Self::Failed, Self::Skipped]
            .into_iter()
            .find(|status| status.as_str() == name)
    }
}

/// One build of suggestions for an index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuerySuggestionsBuild {
    /// The ID of the build, a random UUID.
    pub build_id: String,
    /// What started the build.
    pub trigger: QuerySuggestionsBuildTrigger,
    /// The stage that the build has reached.
    pub status: QuerySuggestionsBuildStatus,
    /// When the build started, in milliseconds since the Unix epoch.
    pub started_at: u64,
    /// When the build ended, in milliseconds since the Unix epoch, or `None` while it runs.
    pub ended_at: Option<u64>,
    /// The number of suggestions that the build added or whose count it changed.
    pub published: u64,
    /// The number of suggestions that the build removed.
    pub removed: u64,
    /// The number of phrases that the build left out because the merge held as many as its limits allow.
    pub discarded: u64,
    /// The code of the error that stopped a failed build.
    pub error_code: Option<String>,
}

/// The popular query suggestions of one index, which [`QuerySuggestions::status`] returns.
///
/// [`QuerySuggestions::status`]: super::QuerySuggestions::status
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuerySuggestionsStatus {
    /// The index.
    pub index_name: String,
    /// The setting of the index, or `None` where it has none.
    pub setting: Option<QuerySuggestionsSetting>,
    /// The build under way, or the last one that ended.
    pub last_build: Option<QuerySuggestionsBuild>,
    /// When the schedule next starts a build, in milliseconds since the Unix epoch.
    pub next_build_at: Option<i64>,
    /// The name of every suggestions index of the index, sorted.
    pub suggestion_indexes: Vec<String>,
}

/// One phrase that a build would publish, which a preview lists.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuerySuggestionPreviewEntry {
    /// The group whose suggestions index would hold the phrase.
    pub group: String,
    /// The phrase.
    pub query: String,
    /// The number of searches of the phrase.
    pub count: u64,
}

/// The phrases that a build would publish now, most searched first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuerySuggestionsPreview {
    /// The phrases, up to the limit that the caller gave.
    pub entries: Vec<QuerySuggestionPreviewEntry>,
    /// Whether the preview stopped at the limit with phrases left to check.
    pub truncated: bool,
}

/// A suggestion that a caller adds by hand, which a build keeps whatever the searches say.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManualQuerySuggestion {
    /// The group whose suggestions index holds the suggestion.
    pub group: String,
    /// The text of the suggestion.
    pub query: String,
    /// The count that the suggestion carries, from 0 to 4,294,967,295, or 0 where absent.
    pub count: Option<u64>,
}

/// The stage of a build that an event reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum QuerySuggestionsBuildPhase {
    /// The build started.
    Started,
    /// The build wrote its suggestions.
    Completed,
    /// The build stopped with an error and undid what it wrote.
    Failed,
    /// The build found nothing new to merge, or another build of the index was under way.
    Skipped,
}

/// The problem that a warning reports, which the engine works around.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum QuerySuggestionsWarningReason {
    /// The engine failed to write a history file or a build record, and it keeps the counts in memory.
    SaveFailed,
    /// A history file breaks a rule of the format, so the engine skips it.
    DamagedFile,
    /// A different key scrambled the people of a history file, so the engine skips it.
    OtherKey,
    /// An index has the feature on while the engine has no key, so the engine counts nothing for it.
    NoKey,
    /// A day reached `maxPhrasesPerDay`.
    PhraseLimit,
    /// A day reached `maxPeoplePerDay`.
    PeopleLimit,
    /// The engine failed to remove a banned phrase from a suggestions index after a restore.
    BanRemovalFailed,
}

impl QuerySuggestionsWarningReason {
    /// Returns the reason as every Narsil implementation spells it.
    pub fn as_str(self) -> &'static str {
        match self {
            QuerySuggestionsWarningReason::SaveFailed => "save-failed",
            QuerySuggestionsWarningReason::DamagedFile => "damaged-file",
            QuerySuggestionsWarningReason::OtherKey => "other-key",
            QuerySuggestionsWarningReason::NoKey => "no-key",
            QuerySuggestionsWarningReason::PhraseLimit => "phrase-limit",
            QuerySuggestionsWarningReason::PeopleLimit => "people-limit",
            QuerySuggestionsWarningReason::BanRemovalFailed => "ban-removal-failed",
        }
    }
}
