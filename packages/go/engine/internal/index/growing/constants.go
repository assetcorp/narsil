package growing

const (
	termTableStartCapacity     = 1 << 10
	postingPoolStartEntries    = 1 << 12
	positionPoolStartValues    = 1 << 12
	retiredStartWords          = (1 << 10) >> 5
	surfaceTableStartCapacity  = 16
	runTableStartCapacity      = 16
	runMemberStartCapacity     = 256
	termUnitsStartCapacity     = 1 << 12
	termTableHeaderWords       = 8
	firstUnitHeads             = 1 << 16
	termRegionGrowthFactor     = 2
	termSlotLoadNumerator      = 1
	termSlotLoadDenominator    = 2
	runMemberBoundFactor       = 3
	poolVacuumFreeFraction     = 0.25
	termVacuumMinDeadTerms     = 1 << 10
	poolVacuumMinFreeEntries   = 1 << 14
	positionVacuumMinFreeValue = 1 << 14
)

const (
	maxPoolEntries    = 1<<32 - 1
	lastSlotOrdinal   = 0x7ffffffe
	lastOffset        = 0xffffffff
	lastSlotCapacity  = 0x80000000
	lastRunCount      = 0x7fffffff
	lastOrdinalBound  = 0xffffffff
	maxStringOrdinal  = 0x7fffffff
	maxStringUnits    = 0xffffffff
	maxLookupUnits    = 0xffffffff
	noFreeSlice       = 0xffffffff
	runPoints         = 3
	runPointBytes     = 4
	spellingMinPoints = 3
	allocationEnd     = 0
	allocationFree    = 1
	allocationWords   = 2
)

const (
	headerCount        = 0
	headerLiveCount    = 1
	headerSlotCapacity = 2
	headerGeneration   = 3
	headerUnitsUsed    = 4
)

const (
	columnReserveBytes    = 64 << 20
	columnReserveGrowth   = 4
	fnvOffsetBasis        = 0x811c9dc5
	fnvPrime              = 0x01000193
	preparedTokenCapacity = 64
	termLiveFlag          = 1
)
