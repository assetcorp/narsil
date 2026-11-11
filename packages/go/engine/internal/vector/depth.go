package vector

import "math"

type dimensionBand int

const (
	narrowBand dimensionBand = iota
	middleBand
	wideBand
)

type rescoreDepthRule struct {
	perLimit             float64
	perSquareRootOfLimit float64
}

var rescoreDepthByBits = map[uint32][3]rescoreDepthRule{
	1: {{3.23, 55.9}, {2.2, 27}, {3, 0}},
	2: {{2.6, 22.5}, {1, 16}, {3, 0}},
	4: {{5, 0}, {5, 0}, {2, 0}},
	8: {{2, 0}, {2, 0}, {2, 0}},
}

var rescoreDepthFloorPerLimitByBits = map[uint32]float64{1: 3, 2: 3, 4: 1, 8: 1}

func bandOf(dimension int) dimensionBand {
	if dimension < narrowDimensionLimit {
		return narrowBand
	}
	if dimension < wideDimensionLimit {
		return middleBand
	}
	return wideBand
}

func efSearchMargin(band dimensionBand) int {
	switch band {
	case narrowBand:
		return efSearchMarginNarrow
	case middleBand:
		return efSearchMarginMiddle
	}
	return efSearchMarginWide
}

func defaultEfSearchFor(dimension, limit int) int {
	return max(defaultEfSearch, limit+efSearchMargin(bandOf(dimension)))
}

func RescoreDepth(bits uint32, dimension, window int, oversample float64) int {
	byDefault := defaultRescoreDepth(bits, dimension, window)
	if oversample <= 0 {
		return byDefault
	}
	ceiling := float64(max(oversampledDepthFloor, byDefault))
	return int(math.Min(math.Ceil(float64(window)*oversample), ceiling))
}

func defaultRescoreDepth(bits uint32, dimension, limit int) int {
	band := bandOf(dimension)
	rule := rescoreDepthByBits[bits][band]
	floor := float64(rescoreDepthFloorPerLimitByBits[bits] * float64(limit))
	root := math.Sqrt(float64(limit))
	depth := math.Max(floor, math.Ceil(float64(rule.perLimit*float64(limit))+float64(rule.perSquareRootOfLimit*root)))
	if bits != 2 || band != middleBand {
		return int(depth)
	}
	withinDefaultWalk := math.Min(
		float64(limit+efSearchMarginMiddle),
		math.Ceil(float64(limit)+float64(osq2MiddleRescoreDepthPerSquareRootOfLimit*root)),
	)
	return int(math.Max(depth, withinDefaultWalk))
}
