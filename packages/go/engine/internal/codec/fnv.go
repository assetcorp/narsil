package codec

import (
	"math"

	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

const (
	FNVOffsetBasis uint32 = 2166136261
	FNVPrime       uint32 = 16777619
)

func FNV1aContinue(hash uint32, data []byte) uint32 {
	for _, value := range data {
		hash = (hash ^ uint32(value)) * FNVPrime
	}
	return hash
}

func FNV1a(data []byte) uint32 {
	return FNV1aContinue(FNVOffsetBasis, data)
}

func FNV1aString(value string) uint32 {
	hash := FNVOffsetBasis
	for index := 0; index < len(value); index++ {
		hash = (hash ^ uint32(value[index])) * FNVPrime
	}
	return hash
}

func FNV1aContinueTaggedNumbers(hash uint32, tag uint32, numbers []float64) uint32 {
	for _, number := range numbers {
		bits := math.Float64bits(float64(float32(number)))
		hash = (hash ^ tag) * FNVPrime
		for shift := 56; shift >= 0; shift -= 8 {
			hash = (hash ^ uint32(byte(bits>>shift))) * FNVPrime
		}
	}
	return hash
}

func FNV1aUint32s(values []uint32) uint32 {
	hash := FNVOffsetBasis
	for _, value := range values {
		for shift := 24; shift >= 0; shift -= 8 {
			hash = (hash ^ (value>>shift)&0xFF) * FNVPrime
		}
	}
	return hash
}

func fnv1aContinueUnit(hash uint32, unit uint16) uint32 {
	hash = (hash ^ uint32(unit&0xFF)) * FNVPrime
	return (hash ^ uint32(unit>>8)) * FNVPrime
}

func FNV1aUTF16Units(units []uint16) uint32 {
	hash := FNVOffsetBasis
	for _, unit := range units {
		hash = fnv1aContinueUnit(hash, unit)
	}
	return hash
}

func FNV1aUTF16(value string) uint32 {
	hash := FNVOffsetBasis
	text.ForEachUTF16Unit(value, func(unit uint16) {
		hash = fnv1aContinueUnit(hash, unit)
	})
	return hash
}

func FNV1aCodePoints(codePoints []rune) uint32 {
	hash := FNVOffsetBasis
	for _, codePoint := range codePoints {
		unsigned := uint32(codePoint)
		for shift := 0; shift < 32; shift += 8 {
			hash = (hash ^ (unsigned>>shift)&0xFF) * FNVPrime
		}
	}
	return hash
}
