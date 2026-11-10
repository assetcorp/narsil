package segments

const (
	PendingRemovalDocuments           = 64
	PendingRemovalTokens              = 1024
	PendingRemovalUnits               = 16384
	PendingRemovalGrowthFactor        = 2
	PendingRemovalGrowthLimitBytes    = 64 << 20
	PendingRemovalLowMemoryLimitBytes = 64 << 10
	FrozenRemovalMaxProcessFraction   = 0.9
	PreparedRemovalReplacements       = 5
	CompactionSegmentTrigger          = 8
	SegmentsPerMerge                  = 8
	tombstoneWordKind                 = 4
	tombstoneCountKind                = 5
	pendingHeaderKind                 = 6
)
