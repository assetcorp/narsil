package partition

import "time"

const (
	firstReaderWait   = 2 * time.Microsecond
	longestReaderWait = time.Millisecond
)

const (
	stringHeaderBytes     = 16
	twoByteSampleLimit    = 16
	numberBytes           = 16
	primitiveSlotBytes    = 4
	arrayHeaderBytes      = 32
	arraySlotBytes        = 8
	objectHeaderBytes     = 40
	propertySlotBytes     = 8
	typedArrayHeaderBytes = 96
)

const (
	defaultBM25K1        = 1.2
	defaultBM25B         = 0.75
	unknownFieldRank     = 0x10000
	phraseWorkFlushUnits = 65_536
)

const (
	documentEntryOverheadBytes = 260
	lengthColumnSlotBytes      = 6
	documentFrequencyBytes     = 44
	surfaceEntryOverheadBytes  = 140
	fieldEntryOverheadBytes    = 42
	sidesPerPartition          = 2
)

const wordBits = 32

const parallelAnalysisDocumentsPerWorker = 32

const (
	arrayPositionGap          = 100
	maxTermFrequency          = 65535
	firstLengthColumnCapacity = 64
	maxCompareDepth           = 64
)
