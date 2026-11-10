package model

import "time"

type QuerySuggestionsSetting struct {
	Enabled               bool
	Fields                []string
	MinPeople             Optional[int]
	MinResults            Optional[int]
	RetentionDays         Optional[int]
	MaxPhrasesPerDay      Optional[int]
	MaxPhrasesPerPerson   Optional[int]
	MaxPeoplePerDay       Optional[int]
	MaxGroups             Optional[int]
	MinLetters            Optional[int]
	MaxLength             Optional[int]
	MaxWords              Optional[int]
	MaxDigits             Optional[int]
	MaxMergePhrases       Optional[int]
	MergeMemoryBytes      Optional[int64]
	SaveInterval          Optional[time.Duration]
	ResultChecksPerSecond Optional[int]
	Schedule              Optional[string]
	TimeZone              Optional[string]
}

type QuerySuggestionsSource struct {
	Index string
	Group string
}

type RecordQueryOutcome string

const (
	RecordQueryRecorded     RecordQueryOutcome = "recorded"
	RecordQueryRepeat       RecordQueryOutcome = "repeat"
	RecordQueryInvalid      RecordQueryOutcome = "invalid"
	RecordQueryBanned       RecordQueryOutcome = "banned"
	RecordQueryPersonLimit  RecordQueryOutcome = "person-limit"
	RecordQueryPhraseLimit  RecordQueryOutcome = "phrase-limit"
	RecordQueryPeopleLimit  RecordQueryOutcome = "people-limit"
	RecordQueryGroupLimit   RecordQueryOutcome = "group-limit"
	RecordQueryNoKey        RecordQueryOutcome = "no-key"
	RecordQueryUnidentified RecordQueryOutcome = "unidentified"
)

type RecordQueryResult struct {
	Recorded bool
	Outcome  RecordQueryOutcome
}

type RecordedQuery struct {
	Query  string
	Person string
	Group  string
}

type QuerySuggestionsBuildTrigger string

const (
	BuildTriggerSchedule QuerySuggestionsBuildTrigger = "schedule"
	BuildTriggerMissed   QuerySuggestionsBuildTrigger = "missed"
	BuildTriggerCaller   QuerySuggestionsBuildTrigger = "caller"
)

type QuerySuggestionsBuildPhase string

const (
	BuildRunning   QuerySuggestionsBuildPhase = "running"
	BuildStarted   QuerySuggestionsBuildPhase = "started"
	BuildCompleted QuerySuggestionsBuildPhase = "completed"
	BuildFailed    QuerySuggestionsBuildPhase = "failed"
	BuildSkipped   QuerySuggestionsBuildPhase = "skipped"
)

type QuerySuggestionsBuild struct {
	BuildID   string
	Trigger   QuerySuggestionsBuildTrigger
	Status    QuerySuggestionsBuildPhase
	StartedAt time.Time
	EndedAt   Optional[time.Time]
	Published int
	Removed   int
	Discarded int
	ErrorCode string
}

type QuerySuggestionsStatus struct {
	IndexName         string
	Setting           *QuerySuggestionsSetting
	LastBuild         *QuerySuggestionsBuild
	NextBuildAt       Optional[time.Time]
	SuggestionIndexes []string
}

type QuerySuggestionPreviewEntry struct {
	Group string
	Query string
	Count int
}

type QuerySuggestionsPreview struct {
	Entries   []QuerySuggestionPreviewEntry
	Truncated bool
}

type ManualQuerySuggestion struct {
	Group string
	Query string
	Count int
}

type QuerySuggestionsBuildEvent struct {
	IndexName string
	BuildID   string
	Phase     QuerySuggestionsBuildPhase
	Trigger   QuerySuggestionsBuildTrigger
	Published int
	Removed   int
	Discarded int
	ErrorCode string
}

type QuerySuggestionsWarningReason string

const (
	WarningSaveFailed       QuerySuggestionsWarningReason = "save-failed"
	WarningDamagedFile      QuerySuggestionsWarningReason = "damaged-file"
	WarningOtherKey         QuerySuggestionsWarningReason = "other-key"
	WarningNoKey            QuerySuggestionsWarningReason = "no-key"
	WarningPhraseLimit      QuerySuggestionsWarningReason = "phrase-limit"
	WarningPeopleLimit      QuerySuggestionsWarningReason = "people-limit"
	WarningBanRemovalFailed QuerySuggestionsWarningReason = "ban-removal-failed"
)

type QuerySuggestionsWarningEvent struct {
	IndexName string
	Reason    QuerySuggestionsWarningReason
	File      string
	Message   string
}
