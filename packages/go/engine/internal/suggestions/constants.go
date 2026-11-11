package suggestions

const (
	HistoryFolder            = "_query-counts"
	RestoredFolder           = "restored"
	RestoreStagingInfix      = ".restoring-"
	BuildRecordFile          = "build.nrsl"
	ArchiveEntryPrefix       = "query-history/"
	MaxHistoryFileBytes      = 16_777_216
	MaxIndexUUIDLength       = 255
	KeyFingerprintLabel      = "narsil.query-suggestions.key"
	SuggestionsIndexInfix    = ".suggestions."
	MinKeyBytes              = 32
	ScrambledIDBytes         = 16
	KeyFingerprintBytes      = 16
	SourcesDigestBytes       = 32
	MaxPeoplePerPhraseInFile = 4_096
	MaxUint32                = 0xffff_ffff

	DefaultPreviewLimit      = 100
	MaxPreviewLimit          = 1_000
	MaxManualSuggestionCount = 4_294_967_295

	PairBlockSlots      = 16
	PairPageBlocks      = 16_384
	PersonTableMinSlots = 1_024
	MinPhraseTableSlots = 64

	DayMS                  = 86_400_000
	HistorySweepIntervalMS = 3_600_000
	ScheduleLookaheadDays  = 2_922
	MaxScheduleLength      = 256
	BuildWriteBatch        = 500
	BuildListPage          = 1_000

	MergeEntryOverheadBytes = 128
	MergePersonBytes        = 48
	MaxTimerDelayMS         = 2_147_483_647

	countsFileFormatVersion  = 1
	buildRecordFormatVersion = 1
)
