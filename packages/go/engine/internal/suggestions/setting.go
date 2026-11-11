package suggestions

import (
	is "github.com/assetcorp/narsil/packages/go/engine/internal/format/indexsettings"
	"github.com/assetcorp/narsil/packages/go/engine/internal/suggestions/phrase"
)

const (
	DefaultSchedule = "0 3 * * *"
	DefaultTimeZone = "UTC"
)

type Resolved struct {
	Enabled               bool
	Fields                []string
	MinPeople             int
	MinResults            int
	RetentionDays         int
	MaxPhrasesPerDay      int
	MaxPhrasesPerPerson   int
	MaxPeoplePerDay       int
	MaxGroups             int
	MinLetters            int
	MaxLength             int
	MaxWords              int
	MaxDigits             int
	MaxMergePhrases       int
	MergeMemoryBytes      int64
	SaveIntervalMS        int64
	ResultChecksPerSecond int
	Schedule              string
	TimeZone              string
}

func Resolve(setting is.QuerySuggestionsSetting) Resolved {
	return Resolved{
		Enabled:               setting.Enabled,
		Fields:                append([]string(nil), setting.Fields...),
		MinPeople:             int(setting.MinPeople.Or(is.DefaultMinPeople)),
		MinResults:            int(setting.MinResults.Or(is.DefaultMinResults)),
		RetentionDays:         int(setting.RetentionDays.Or(is.DefaultRetentionDays)),
		MaxPhrasesPerDay:      int(setting.MaxPhrasesPerDay.Or(is.DefaultMaxPhrasesPerDay)),
		MaxPhrasesPerPerson:   int(setting.MaxPhrasesPerPerson.Or(is.DefaultMaxPhrasesPerPerson)),
		MaxPeoplePerDay:       int(setting.MaxPeoplePerDay.Or(is.DefaultMaxPeoplePerDay)),
		MaxGroups:             int(setting.MaxGroups.Or(is.DefaultMaxGroups)),
		MinLetters:            int(setting.MinLetters.Or(is.DefaultMinLetters)),
		MaxLength:             int(setting.MaxLength.Or(is.DefaultMaxLength)),
		MaxWords:              int(setting.MaxWords.Or(is.DefaultMaxWords)),
		MaxDigits:             int(setting.MaxDigits.Or(is.DefaultMaxDigits)),
		MaxMergePhrases:       int(setting.MaxMergePhrases.Or(is.DefaultMaxMergePhrases)),
		MergeMemoryBytes:      setting.MergeMemoryBytes.Or(is.DefaultMergeMemoryBytes),
		SaveIntervalMS:        setting.SaveIntervalMS.Or(is.DefaultSaveIntervalMS),
		ResultChecksPerSecond: int(setting.ResultChecksPerSecond.Or(is.DefaultResultChecksPerSecond)),
		Schedule:              setting.Schedule.Or(DefaultSchedule),
		TimeZone:              setting.TimeZone.Or(DefaultTimeZone),
	}
}

func (resolved Resolved) PhraseLimits() phrase.Limits {
	return phrase.Limits{MinLetters: resolved.MinLetters, MaxLength: resolved.MaxLength, MaxWords: resolved.MaxWords,
		MaxDigits: resolved.MaxDigits}
}

var FileLimits = phrase.Limits{MinLetters: 1, MaxLength: is.MaxMaxLength, MaxWords: is.MaxMaxWords, MaxDigits: is.MaxMaxLength}

var BanLimits = phrase.Limits{MinLetters: 0, MaxLength: is.MaxBannedPhraseCodePoints,
	MaxWords: is.MaxBannedPhraseCodePoints, MaxDigits: is.MaxBannedPhraseCodePoints}
