package geo

import (
	"math"
	"slices"
)

type locationBox struct {
	south float64
	north float64
	west  float64
	east  float64
}

type codeRange struct {
	from uint64
	to   uint64
}

const axisCells = 1 << locationCodeBitsPerAxis

func axisCell(value, lowest, span float64) int {
	cell := math.Floor(((value - lowest) / span) * axisCells)
	if !(cell > 0) {
		return 0
	}
	if cell >= axisCells {
		return axisCells - 1
	}
	return int(cell)
}

func latitudeCell(lat float64) int {
	return axisCell(lat, -maxLatitudeDegrees, 2*maxLatitudeDegrees)
}

func longitudeCell(lon float64) int {
	return axisCell(lon, -maxLongitudeDegrees, fullTurnDegrees)
}

func interleave(row, column, bits int) uint64 {
	var code uint64
	for bit := bits - 1; bit >= 0; bit-- {
		code = code*4 + uint64((row>>bit)&1)*2 + uint64((column>>bit)&1)
	}
	return code
}

func locationCode(lat, lon float64) uint64 {
	return interleave(latitudeCell(lat), longitudeCell(lon), locationCodeBitsPerAxis)
}

func appendBoxRanges(box locationBox, out []codeRange) []codeRange {
	south := latitudeCell(box.south)
	north := latitudeCell(box.north)
	west := longitudeCell(box.west)
	east := longitudeCell(box.east)
	level := locationCodeBitsPerAxis
	for level > 0 {
		shift := locationCodeBitsPerAxis - level
		rows := (north >> shift) - (south >> shift) + 1
		columns := (east >> shift) - (west >> shift) + 1
		if rows*columns <= maxCoveringCells {
			break
		}
		level--
	}
	shift := locationCodeBitsPerAxis - level
	codesPerCell := uint64(1) << (2 * shift)
	for row := south >> shift; row <= north>>shift; row++ {
		for column := west >> shift; column <= east>>shift; column++ {
			from := interleave(row, column, level) * codesPerCell
			out = append(out, codeRange{from: from, to: from + codesPerCell})
		}
	}
	return out
}

func coveringRanges(boxes []locationBox) []codeRange {
	var ranges []codeRange
	for _, box := range boxes {
		ranges = appendBoxRanges(box, ranges)
	}
	slices.SortFunc(ranges, func(left, right codeRange) int {
		switch {
		case left.from < right.from:
			return -1
		case left.from > right.from:
			return 1
		}
		return 0
	})
	merged := make([]codeRange, 0, len(ranges))
	for _, next := range ranges {
		if last := len(merged) - 1; last >= 0 && next.from <= merged[last].to {
			if next.to > merged[last].to {
				merged[last].to = next.to
			}
			continue
		}
		merged = append(merged, next)
	}
	return merged
}

func rangesHold(ranges []codeRange, code uint64) bool {
	at, _ := slices.BinarySearchFunc(ranges, code, func(candidate codeRange, target uint64) int {
		if candidate.to <= target {
			return -1
		}
		return 1
	})
	return at < len(ranges) && ranges[at].from <= code
}

func longitudeBoxes(south, north, west, east float64) []locationBox {
	if east-west >= fullTurnDegrees {
		return []locationBox{{south: south, north: north, west: -maxLongitudeDegrees, east: maxLongitudeDegrees}}
	}
	if west < -maxLongitudeDegrees {
		return []locationBox{
			{south: south, north: north, west: west + fullTurnDegrees, east: maxLongitudeDegrees},
			{south: south, north: north, west: -maxLongitudeDegrees, east: east},
		}
	}
	if east > maxLongitudeDegrees {
		return []locationBox{
			{south: south, north: north, west: west, east: maxLongitudeDegrees},
			{south: south, north: north, west: -maxLongitudeDegrees, east: east - fullTurnDegrees},
		}
	}
	return []locationBox{{south: south, north: north, west: west, east: east}}
}
