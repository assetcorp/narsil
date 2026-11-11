package query

const (
	growingTermLive      = 1
	growingTermOrdered   = 2
	growingTermPositions = 4
)

const (
	DefaultBM25K1       = 1.2
	DefaultBM25B        = 0.75
	DefaultPrefixLength = 2
	PrefixExpansions    = 50
	absentFieldAverage  = 1
	fieldSlots          = 1 << 16
	MaxPhraseWords      = 32
	MaxQueryPhrases     = 32
)

const (
	MaxFilterDepth          = 30
	MaxFilterTests          = 1024
	MaxFilterListItems      = 65536
	DefaultPatternWorkCap   = 25_000_000
	MatcherStateBudgetBytes = 1_000_000
	SortValueMaxCodePoints  = 512
)
