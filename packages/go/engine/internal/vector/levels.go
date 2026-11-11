package vector

import (
	"math"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
)

const (
	goldenGamma         = 0x9e3779b9
	firstMixMultiplier  = 0x21f0aaad
	secondMixMultiplier = 0x735a2d97
	twoToThe32          = 4294967296.0
	halfAStep           = 0.5
)

func mixedUint32(value uint32) uint32 {
	mixed := value + goldenGamma
	mixed ^= mixed >> 16
	mixed *= firstMixMultiplier
	mixed ^= mixed >> 15
	mixed *= secondMixMultiplier
	mixed ^= mixed >> 15
	return mixed
}

func unitDrawOf(value uint32) float64 {
	return (float64(mixedUint32(value)) + halfAStep) / twoToThe32
}

func levelMultiplier(m int) float64 {
	return 1 / core.Ln(float64(m))
}

func levelOfOrdinal(ordinal int32, multiplier float64) int32 {
	drawn := math.Floor(float64(-core.Ln(unitDrawOf(uint32(ordinal))) * multiplier))
	if drawn > maxLayerCap {
		return maxLayerCap
	}
	return int32(drawn)
}

func shuffleInPlace[T any](items []T) {
	stream := uint32(len(items))
	for i := len(items) - 1; i > 0; i-- {
		stream = mixedUint32(stream)
		j := int(math.Floor(float64(float64(stream)/twoToThe32) * float64(i+1)))
		items[i], items[j] = items[j], items[i]
	}
}
