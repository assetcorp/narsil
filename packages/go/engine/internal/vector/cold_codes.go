package vector

import (
	"encoding/binary"
	"math"
	"math/bits"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

type osqQueryCode struct {
	levels     []uint8
	lower      float64
	upper      float64
	correction float64
	sum        float64
}

type osqTrailer struct {
	lower      float64
	upper      float64
	correction float64
	sum        float64
}

func osqCodeBytes(dimension int, codeBits uint32) int {
	return (dimension*int(codeBits) + 7) / 8
}

func osqRecordBytes(dimension int, codeBits uint32) int {
	return osqCodeBytes(dimension, codeBits) + osqRecordTrailerBytes
}

func osqQueryBitsOf(codeBits uint32) uint32 {
	if codeBits == osqWideQueryBits {
		return osqWideQueryBits
	}
	return osqNarrowQueryBits
}

func osqStagedQueryBytes(dimension int, codeBits uint32) int {
	switch codeBits {
	case 8:
		return dimension
	case 4:
		return osqCodeBytes(dimension, 4)
	}
	return osqQueryPlanesNarrowCodes * osqCodeBytes(dimension, codeBits)
}

func clampOf(value, low, high float64) float64 {
	return math.Min(math.Max(value, low), high)
}

func uint8OfNumber(value float64) uint8 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0
	}
	return uint8(int64(math.Trunc(math.Mod(value, 256))) & 0xff)
}

func unitNormaliseInto(target []float64, vector []float32) {
	squares := 0.0
	for _, component := range vector {
		value := float64(component)
		squares += float64(value * value)
	}
	length := math.Sqrt(squares)
	for at, component := range vector {
		if length == 0 {
			target[at] = float64(component)
			continue
		}
		target[at] = float64(component) / length
	}
}

func osqLevel(value, lower, upper, steps float64) float64 {
	if upper == lower {
		return 0
	}
	scaled := float64(float64((clampOf(value, lower, upper)-lower)*steps) / (upper - lower))
	return math.Floor(scaled + 0.5)
}

func osqLoss(x []float64, lower, upper, steps, norm float64) float64 {
	kept := 1 - float64(osqLambda)
	alongX, squaredError := 0.0, 0.0
	width := (upper - lower) / steps
	for _, value := range x {
		quantised := lower + float64(width*osqLevel(value, lower, upper, steps))
		difference := value - quantised
		alongX += float64(value * difference)
		squaredError += float64(difference * difference)
	}
	return float64(float64(float64(kept*alongX)*alongX)/norm) + float64(osqLambda*squaredError)
}

func osqRefine(x []float64, lowerStart, upperStart, steps float64) (float64, float64) {
	lower, upper := lowerStart, upperStart
	kept := 1 - float64(osqLambda)
	norm := 0.0
	for _, value := range x {
		norm += float64(value * value)
	}
	if norm == 0 || upper == lower {
		return lower, upper
	}
	best := osqLoss(x, lower, upper, steps, norm)
	for range osqRefineRounds {
		var daa, dab, dbb, dax, dbx float64
		for _, value := range x {
			share := osqLevel(value, lower, upper, steps) / steps
			rest := 1 - share
			daa += float64(rest * rest)
			dab += float64(rest * share)
			dbb += float64(share * share)
			dax += float64(value * rest)
			dbx += float64(value * share)
		}
		m0 := float64(float64(float64(kept*dax)*dax)/norm) + float64(osqLambda*daa)
		m1 := float64(float64(float64(kept*dax)*dbx)/norm) + float64(osqLambda*dab)
		m2 := float64(float64(float64(kept*dbx)*dbx)/norm) + float64(osqLambda*dbb)
		determinant := float64(m0*m2) - float64(m1*m1)
		if determinant == 0 {
			return lower, upper
		}
		nextLower := (float64(m2*dax) - float64(m1*dbx)) / determinant
		nextUpper := (float64(m0*dbx) - float64(m1*dax)) / determinant
		if math.Abs(nextLower-lower) < osqRefineTolerance && math.Abs(nextUpper-upper) < osqRefineTolerance {
			return lower, upper
		}
		candidate := osqLoss(x, nextLower, nextUpper, steps, norm)
		if candidate > best {
			return lower, upper
		}
		lower, upper, best = nextLower, nextUpper, candidate
	}
	return lower, upper
}

func osqQuantizeQuery(vector []float32, centroid []float32, codeBits uint32, metric model.VectorMetric) osqQueryCode {
	dimension := len(vector)
	normalised := make([]float64, dimension)
	if metric == model.MetricCosine {
		unitNormaliseInto(normalised, vector)
	} else {
		for at, component := range vector {
			normalised[at] = float64(component)
		}
	}
	centred := make([]float64, dimension)
	correction, total := 0.0, 0.0
	minimum, maximum := math.Inf(1), math.Inf(-1)
	for at := range dimension {
		centred[at] = normalised[at] - float64(centroid[at])
		if metric == model.MetricEuclidean {
			correction += float64(centred[at] * centred[at])
		} else {
			correction += float64(normalised[at] * float64(centroid[at]))
		}
		total += centred[at]
		if centred[at] < minimum {
			minimum = centred[at]
		}
		if centred[at] > maximum {
			maximum = centred[at]
		}
	}
	mean := total / float64(dimension)
	spread := 0.0
	for _, value := range centred {
		spread += float64((value - mean) * (value - mean))
	}
	deviation := math.Sqrt(spread / float64(dimension))
	steps, grid := osqStepsByBits[codeBits], osqGridByBits[codeBits]
	lower, upper := osqRefine(centred,
		clampOf(mean-float64(grid*deviation), minimum, maximum),
		clampOf(mean+float64(grid*deviation), minimum, maximum), steps)
	code := osqQueryCode{levels: make([]uint8, dimension), lower: lower, upper: upper, correction: correction}
	for at, value := range centred {
		code.levels[at] = uint8OfNumber(osqLevel(value, lower, upper, steps))
		code.sum += float64(code.levels[at])
	}
	return code
}

func stageQueryLevels(levels []uint8, codeBits uint32, target []byte) {
	clear(target)
	switch codeBits {
	case 8:
		copy(target, levels)
		return
	case 4:
		for at, value := range levels {
			target[at/2] |= value << ((at % 2) * 4)
		}
		return
	}
	planeBytes := osqCodeBytes(len(levels), codeBits)
	if codeBits == 2 {
		for at, value := range levels {
			target[(at%osqLevelsInATwoBitByte)*planeBytes+at/osqLevelsInATwoBitByte] = value
		}
		return
	}
	for at, value := range levels {
		for plane := range osqQueryPlanesNarrowCodes {
			if (value>>plane)&1 == 1 {
				target[plane*planeBytes+(at>>3)] |= 1 << (at & 7)
			}
		}
	}
}

func osqQueryProducts(codeBits uint32, dimension int, codeBytes int, record []byte, staged []byte) int {
	total := 0
	switch codeBits {
	case 8:
		for at := range dimension {
			total += int(record[at]) * int(staged[at])
		}
	case 4:
		for at := range codeBytes {
			left, right := int(record[at]), int(staged[at])
			total += (left&15)*(right&15) + (left>>4)*(right>>4)
		}
	case 2:
		for at := range codeBytes {
			packed := int(record[at])
			for plane := range osqQueryPlanesNarrowCodes {
				total += ((packed >> (2 * plane)) & 3) * int(staged[plane*codeBytes+at])
			}
		}
	default:
		for plane := range osqQueryPlanesNarrowCodes {
			set := 0
			for at := range codeBytes {
				set += bits.OnesCount8(record[at] & staged[plane*codeBytes+at])
			}
			total += set << plane
		}
	}
	return total
}

func readOsqTrailer(record []byte, codeBytes int) osqTrailer {
	return osqTrailer{
		lower:      float64(math.Float32frombits(binary.LittleEndian.Uint32(record[codeBytes:]))),
		upper:      float64(math.Float32frombits(binary.LittleEndian.Uint32(record[codeBytes+4:]))),
		correction: float64(math.Float32frombits(binary.LittleEndian.Uint32(record[codeBytes+8:]))),
		sum:        float64(binary.LittleEndian.Uint32(record[codeBytes+12:])),
	}
}

func osqEstimatedDistance(products int, document osqTrailer, codeBits uint32, query osqQueryCode, queryBits uint32,
	dimension int, centroidDot float64, metric model.VectorMetric) float64 {
	documentStep := (document.upper - document.lower) / osqStepsByBits[codeBits]
	queryStep := (query.upper - query.lower) / osqStepsByBits[queryBits]
	first := float64(float64(document.lower*query.lower) * float64(dimension))
	second := float64(float64(query.lower*documentStep) * document.sum)
	third := float64(float64(document.lower*queryStep) * query.sum)
	fourth := float64(float64(documentStep*queryStep) * float64(products))
	centred := float64(float64(first+second)+third) + fourth
	if metric == model.MetricEuclidean {
		return math.Sqrt(math.Max(0, float64(document.correction+query.correction)-float64(2*centred)))
	}
	similarity := float64(float64(centred+document.correction)+query.correction) - centroidDot
	if metric == model.MetricCosine {
		return 1 - math.Min(math.Max(similarity, -1), 1)
	}
	return -similarity
}
