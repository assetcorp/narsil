package postings

const (
	MaxTermFrequency              = 65535
	postingListCompactionFraction = 0.3
	firstSliceCapacity            = 8
	sliceClassCount               = 27
	poolVacuumFreeFraction        = 0.25
	poolVacuumMinFreeEntries      = 1 << 14
	positionVacuumMinFreeValues   = 1 << 14
	termVacuumMinDeadTerms        = 1 << 10
	termEntryEstimatedBytes       = 64
	tokenStringHeaderBytes        = 16
	firstBucketCapacity           = 4
)
