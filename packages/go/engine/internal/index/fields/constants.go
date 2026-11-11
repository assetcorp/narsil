package fields

const (
	numericInitialCapacity       = 16
	pendingRemovalMergeFloor     = 64
	pendingRemovalMergeDivisor   = 256
	storedValuesInitialCapacity  = 64
	storedPayloadInitialCapacity = 128
	sortValuesInitialCapacity    = 64
	sortTextInitialCapacity      = 256
	sortRebuildMinimumThreshold  = 1024
	sortRebuildFractionShift     = 2
	runListInitialCapacity       = 4
	runListCompactionHalves      = 2
	booleanInitialWords          = 1
	geoCodeBitsPerAxis           = 26
	geoCellsPerAxis              = 1 << geoCodeBitsPerAxis
	maxLatitudeDegrees           = 90
	maxLongitudeDegrees          = 180
	fullTurnDegrees              = 360
	maxStringUnits               = 1 << 30
	layoutCountLimit             = 0xffffffff
	bitsPerWord                  = 32
	wordShift                    = 5
	wordMask                     = 31
	runCodePoints                = 3
	documentWordShift            = 6
	documentWordMask             = 63
	documentWordBytes            = 8
	sortStoredOutputTextWords    = 2
	sortOrderCountWords          = 2
	hashEntryBytes               = 16
	geoRowBytes                  = 32
	runEntryOverheadBytes        = 140
)

const (
	DefaultMaxOrdinals       = 1 << 24
	DefaultMaxEntries        = 1 << 27
	DefaultMaxTextUnits      = 1 << 30
	DefaultMaxEncodedBytes   = 1 << 30
	DefaultPatternValueLimit = 8_192
	MaxPatternValueLimit     = 65_536
)

const (
	storedAbsent byte = 0
	storedScalar byte = 1
	storedArray  byte = 2
)

const (
	storedKindNull   byte = 0
	storedKindFalse  byte = 1
	storedKindTrue   byte = 2
	storedKindNumber byte = 3
	storedKindString byte = 4
	storedKindOther  byte = 5
)
