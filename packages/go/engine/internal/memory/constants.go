package memory

import "time"

const (
	WriteFiguresMaxAge                = 10 * time.Millisecond
	recentFiguresMaxCompletedFraction = 0.01
	fullCollectionInterval            = 5 * time.Second
	refusalCollectionMinInterval      = time.Second
	refusalCollectionTimeMultiple     = 10
	processLimitRefreshInterval       = time.Second
	processStatusReadCeilingBytes     = 1 << 20
	kibibyteBytes                     = 1024
)

const (
	documentHeapBytesPerEstimatedByte = 16
	documentValueHeapBytes            = 256
	documentPropertyHeapBytes         = 128
	distinctTermHeapBytes             = 512
	termUnitHeapBytes                 = 24
	partialSpellingHeapBytes          = 512
	patternRunHeapBytes               = 32
	enumValueHeapBytes                = 1024
	vectorComponentHeapBytes          = 16
	vectorDocumentHeapBytes           = 4096
	normalizationExpansionFactor      = 3
	caseFoldExpansionFactor           = 3
	singleClassTermsPerUnit           = 0.5
	ngramTermsPerUnit                 = 1
	float32Bytes                      = 4
	float64Bytes                      = 8
)

const (
	FreezePeakBytesPerGrowingByte   = 6
	SideCopyPeakBytesPerGrowingByte = 3
)

const (
	restoreEstimateMargin = 1.25
	mebibyteBytes         = 1 << 20
)

const (
	restoreWorstHeapBytesPerStoredByte          = 8.1
	restoreWorstHeapBytesPerVector              = 590
	restoreWorstHeapBytesPerVectorDimension     = 27
	restoreWorstProcessBytesPerStoredByte       = 8
	restoreWorstProcessBytesPerVector           = 900
	restoreWorstProcessBytesPerVectorDimension  = 31
	restoreFloorHeapBytesPerStoredByte          = 1.4
	restoreFloorHeapBytesPerVector              = 260
	restoreFloorHeapBytesPerVectorDimension     = 2.4
	restoreFloorProcessBytesPerStoredByte       = 1.4
	restoreFloorProcessBytesPerVector           = 0
	restoreFloorProcessBytesPerVectorDimension  = 6.4
	restoreWorstHeapBytesPerPagedStoredByte     = 1.56
	restoreWorstProcessBytesPerPagedStoredByte  = 1.54
	restoreFloorHeapBytesPerPagedStoredByte     = 1.44
	restoreFloorProcessBytesPerPagedStoredByte  = 1.42
	restoreWorstHeapBytesPerEarlierByte         = 23
	restoreWorstHeapBytesPerEarlierVector       = 5400
	restoreWorstHeapBytesPerEarlierDimension    = 43
	restoreWorstProcessBytesPerEarlierByte      = 23.1
	restoreWorstProcessBytesPerEarlierVector    = 5900
	restoreWorstProcessBytesPerEarlierDimension = 44.5
	restoreFloorHeapBytesPerEarlierByte         = 5.9
	restoreFloorHeapBytesPerEarlierVector       = 930
	restoreFloorHeapBytesPerEarlierDimension    = 9
	restoreFloorProcessBytesPerEarlierByte      = 6.5
	restoreFloorProcessBytesPerEarlierVector    = 900
	restoreFloorProcessBytesPerEarlierDimension = 10.3
)
