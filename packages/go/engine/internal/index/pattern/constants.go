package pattern

const (
	MaxTextCodePoints        = 1_024
	MaxPositions             = 2_048
	MatcherStateBudgetBytes  = 1_000_000
	WorkFlushUnits           = 65_536
	RunCodePoints            = 3
	MaxTolerance             = 2
	maxGroupDepth            = 32
	maxRepeatCount           = 2_048
	maxNumberRangeDigits     = 15
	codePointTestEntryBytes  = 8
	programStateBytes        = 11
	programPositionBytes     = 12
	matcherCodePointBytes    = 8
	matcherSimulationBytes   = 16
	matcherStateOverhead     = 96
	matcherTransitionBytes   = 48
	matcherEdgeSlotBytes     = 8
	maxDenseEdgeClasses      = 64
	matcherKeyCharacterBytes = 2
	minCodePointsPerState    = 10
	shortlistRunLookups      = 16
	shortlistIntersectRatio  = 8
	runListCompactionHalves  = 2
	runEntryOverheadBytes    = 140
	documentEntryBytes       = 24
	simulationStateBytes     = 8
	simulationPositionBytes  = 8
	keptProgramBudgetHalves  = 2
	directClassCodePoints    = 128
	positionsPerWord         = 32
	uint32Bytes              = 4
	simulationContexts       = 9
	lastCodePoint            = 0x10FFFF
)
