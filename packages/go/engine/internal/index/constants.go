package index

import "time"

const (
	maxQueryPhrases             = 32
	maxPhraseWords              = 32
	prefixMaxExpansions         = 50
	defaultFuzzyPrefixLength    = 2
	maxTolerance                = 10
	maxPrefixLength             = 1024
	minPartialWrittenCodePoints = 3
	DefaultSearchWorkCap        = 25_000_000
)

const (
	hybridRescoreWindow    = 10
	minHybridDepth         = 1
	maxHybridDepth         = 10_000
	preflightLimit         = 1000
	maxResultsPerPartition = 1<<31 - 1
	MinEfSearch            = 1
	MaxEfSearch            = 10_000
	MinOversample          = 1
)

const (
	compactionSegmentTrigger = 8
	segmentsPerMerge         = 8
	maxCompactionRounds      = 64
	idleMergeDelay           = time.Second
)

const (
	defaultSuggestLimit = 10
	maxSuggestLimit     = 100
)

const (
	maxBM25K1               = 1000
	maxBM25B                = 1
	bm25DisplayedNameLength = 64
)
