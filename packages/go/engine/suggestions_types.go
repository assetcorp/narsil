package engine

import "github.com/assetcorp/narsil/packages/go/engine/internal/model"

// QuerySuggestionsSetting is the popular query suggestions setting of one
// index. Only Enabled and Fields are required, and each limit that you leave
// unset takes its default: MinPeople 4 (2 to 4,096), MinResults 5 (1 to
// 10,000), RetentionDays 30 (1 to 365), MaxPhrasesPerDay 10,000 (up to
// 16,384), MaxPhrasesPerPerson 100 (up to 1,000), MaxPeoplePerDay 100,000,
// MaxGroups 100 (up to 1,000), MinLetters 4, MaxLength 100 (up to 150),
// MaxWords 8 (up to 50), MaxDigits 5, MaxMergePhrases 100,000 (up to
// 500,000), MergeMemoryBytes 128 MiB (16 MiB to 1 GiB), SaveInterval 5 minutes
// (1 second to 1 hour, in whole milliseconds), ResultChecksPerSecond 20 (up to
// 1,000), Schedule "0 3 * * *" (five cron fields or "off"), and TimeZone "UTC".
type QuerySuggestionsSetting = model.QuerySuggestionsSetting

// QuerySuggestionsSource is the marker of a suggestions index: the index
// whose searches it holds and the group that it serves.
type QuerySuggestionsSource = model.QuerySuggestionsSource

// RecordedQuery is one search that a person followed with a click. Query is
// the search text, which the engine normalises before it counts it. Person
// identifies the searcher in 1 to 256 UTF-16 code units, and the engine keeps
// only a keyed scramble of it. Group is the audience whose suggestions the
// search counts towards, in 1 to 32 letters, digits, "_", and "-".
type RecordedQuery = model.RecordedQuery

// RecordQueryOutcome says why the engine counted a search or left it out.
type RecordQueryOutcome = model.RecordQueryOutcome

// RecordQueryResult reports what RecordQuery did with one search.
type RecordQueryResult = model.RecordQueryResult

// The outcomes that RecordQuery reports.
const (
	// RecordQueryRecorded means the engine counted the search.
	RecordQueryRecorded = model.RecordQueryRecorded
	// RecordQueryRepeat means the person already searched the phrase today.
	RecordQueryRepeat = model.RecordQueryRepeat
	// RecordQueryInvalid means the query, person, or group fails its format.
	RecordQueryInvalid = model.RecordQueryInvalid
	// RecordQueryBanned means the ban list of the index holds the phrase.
	RecordQueryBanned = model.RecordQueryBanned
	// RecordQueryPersonLimit means the person reached MaxPhrasesPerPerson today.
	RecordQueryPersonLimit = model.RecordQueryPersonLimit
	// RecordQueryPhraseLimit means the index reached MaxPhrasesPerDay today.
	RecordQueryPhraseLimit = model.RecordQueryPhraseLimit
	// RecordQueryPeopleLimit means the index reached MaxPeoplePerDay today.
	RecordQueryPeopleLimit = model.RecordQueryPeopleLimit
	// RecordQueryGroupLimit means the group would pass MaxGroups.
	RecordQueryGroupLimit = model.RecordQueryGroupLimit
	// RecordQueryNoKey means the engine has no query suggestions key.
	RecordQueryNoKey = model.RecordQueryNoKey
)

// QuerySuggestionsBuildTrigger says what started a build.
type QuerySuggestionsBuildTrigger = model.QuerySuggestionsBuildTrigger

// QuerySuggestionsBuildPhase is where a build stands, or the phase that a
// build event reports.
type QuerySuggestionsBuildPhase = model.QuerySuggestionsBuildPhase

// The triggers and phases of a build.
const (
	// BuildTriggerSchedule marks a build that the schedule started.
	BuildTriggerSchedule = model.BuildTriggerSchedule
	// BuildTriggerMissed marks a build that start-up ran for a missed schedule.
	BuildTriggerMissed = model.BuildTriggerMissed
	// BuildTriggerCaller marks a build that a call to Build started.
	BuildTriggerCaller = model.BuildTriggerCaller
	// BuildRunning marks a build that has not ended.
	BuildRunning = model.BuildRunning
	// BuildStarted is the phase of the event that a build raises as it starts.
	BuildStarted = model.BuildStarted
	// BuildCompleted marks a build that wrote its suggestions.
	BuildCompleted = model.BuildCompleted
	// BuildFailed marks a build that stopped on an error and undid its writes.
	BuildFailed = model.BuildFailed
	// BuildSkipped marks a build that found nothing new, or one that another
	// build of the same index was already running for.
	BuildSkipped = model.BuildSkipped
)

// QuerySuggestionsBuild describes one build of the suggestions of an index.
// ErrorCode is empty unless the build failed.
type QuerySuggestionsBuild = model.QuerySuggestionsBuild

// QuerySuggestionsStatus reports the setting, the last build, the next
// scheduled build, and the suggestions indexes of one index.
type QuerySuggestionsStatus = model.QuerySuggestionsStatus

// QuerySuggestionPreviewEntry is one phrase that a build would publish.
type QuerySuggestionPreviewEntry = model.QuerySuggestionPreviewEntry

// QuerySuggestionsPreview lists what the next build would publish, most
// counted first. Truncated is true where the list stops at the limit while
// more phrases wait to be checked.
type QuerySuggestionsPreview = model.QuerySuggestionsPreview

// ManualQuerySuggestion is a suggestion that a caller adds by hand. Count
// ranks the phrase and defaults to 0.
type ManualQuerySuggestion = model.ManualQuerySuggestion

// QuerySuggestionsWarningReason says why the engine raised a query
// suggestions warning.
type QuerySuggestionsWarningReason = model.QuerySuggestionsWarningReason
