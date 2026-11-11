package indexsettings

const (
	MaxSynonymRules         = 100_000
	MaxSynonymWords         = 500_000
	MaxSynonymWordBytes     = 4_194_304
	MaxSynonymRuleWords     = 100
	MinTwoWaySynonymWords   = 2
	MinOneWaySynonyms       = 1
	FirstPrintableCodePoint = 0x20

	DefaultMinPeople             = 4
	MinMinPeople                 = 2
	MaxMinPeople                 = 4_096
	DefaultMinResults            = 5
	MinMinResults                = 1
	MaxMinResults                = 10_000
	DefaultRetentionDays         = 30
	MinRetentionDays             = 1
	MaxRetentionDays             = 365
	DefaultMaxPhrasesPerDay      = 10_000
	MaxMaxPhrasesPerDay          = 16_384
	DefaultMaxPhrasesPerPerson   = 100
	MaxMaxPhrasesPerPerson       = 1_000
	DefaultMaxPeoplePerDay       = 100_000
	MaxMaxPeoplePerDay           = 100_000
	DefaultMaxGroups             = 100
	MaxMaxGroups                 = 1_000
	DefaultMinLetters            = 4
	DefaultMaxLength             = 100
	MaxMaxLength                 = 150
	DefaultMaxWords              = 8
	MaxMaxWords                  = 50
	DefaultMaxDigits             = 5
	DefaultMaxMergePhrases       = 100_000
	MaxMaxMergePhrases           = 500_000
	DefaultMergeMemoryBytes      = 134_217_728
	MinMergeMemoryBytes          = 16_777_216
	MaxMergeMemoryBytes          = 1_073_741_824
	DefaultSaveIntervalMS        = 300_000
	MinSaveIntervalMS            = 1_000
	MaxSaveIntervalMS            = 3_600_000
	DefaultResultChecksPerSecond = 20
	MaxResultChecksPerSecond     = 1_000

	MaxPersonPairsPerDay = 10_000_000
	MaxFilePeoplePerDay  = 65_536
	MaxMergePeople       = 2_097_152

	MaxSuggestionFields          = 32
	MaxSettingBytes              = 16_384
	MaxBannedPhrases             = 1_000
	MaxBanListBytes              = 262_144
	MaxBannedPhraseCodePoints    = 150
	MaxSourceIndexNameLength     = 210
	MaxGroupLength               = 32
	RawPhraseUnitsPerCodePoint   = 8
	MaxScheduleLength            = 256
	ScheduleOff                  = "off"
	MaxScheduleFieldNumberDigits = 2

	MaxPartitionCount = 65_536
)
