package schema

import "math"

const smallestMagnitudeRoundingToFloat32Infinity = 0x1.ffffffp127

func Float32Representable(value float64) bool {
	return !math.IsNaN(value) && math.Abs(value) < smallestMagnitudeRoundingToFloat32Infinity
}
