package core

const (
	MaxIdleAnalyserUnits  = 1 << 20
	MaxIdleWorkspaceBytes = 64 << 20
)

const (
	minExactTermSlots            = 2
	maxExactTermSlots            = 1 << 31
	exactTermSlotGrowthFactor    = 2
	exactTermSlotLoadNumerator   = 1
	exactTermSlotLoadDenominator = 2
)
