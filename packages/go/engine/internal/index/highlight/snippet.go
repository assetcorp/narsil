package highlight

import (
	"cmp"
	"slices"
	"sort"
)

const ellipsis = "..."

var ellipsisUnits = []uint16{'.', '.', '.'}

type span struct {
	start int
	end   int
}

func mergeOverlapping(ranges []span) []span {
	if len(ranges) == 0 {
		return nil
	}
	sorted := slices.Clone(ranges)
	slices.SortStableFunc(sorted, func(left, right span) int { return cmp.Compare(left.start, right.start) })
	merged := []span{sorted[0]}
	for _, current := range sorted[1:] {
		previous := &merged[len(merged)-1]
		if current.start <= previous.end {
			previous.end = max(previous.end, current.end)
			continue
		}
		merged = append(merged, current)
	}
	return merged
}

func densestWindow(positions []span, textLength, windowSize int) span {
	bestStart, bestCount := 0, 0
	for _, position := range positions {
		windowStart := max(0, position.start-windowSize/2)
		windowEnd := min(textLength, windowStart+windowSize)
		adjustedStart := max(0, windowEnd-windowSize)
		first := sort.Search(len(positions), func(index int) bool { return positions[index].start >= adjustedStart })
		past := sort.Search(len(positions), func(index int) bool { return positions[index].end > windowEnd })
		if count := past - first; count > bestCount {
			bestCount = count
			bestStart = adjustedStart
		}
	}
	return span{start: bestStart, end: min(textLength, bestStart+windowSize)}
}

func truncatedSnippet(units []uint16, positions []span, maxLength int, preTag, postTag []uint16) ([]uint16, []span) {
	window := densestWindow(positions, len(units), maxLength)
	var visible, withinSnippet []span
	for _, position := range positions {
		if position.start < window.start || position.end > window.end {
			continue
		}
		visible = append(visible, position)
		withinSnippet = append(withinSnippet, span{start: position.start - window.start, end: position.end - window.start})
	}
	tagged := insertTags(units[window.start:window.end], withinSnippet, preTag, postTag)
	snippet := make([]uint16, 0, len(tagged)+2*len(ellipsisUnits))
	if window.start > 0 {
		snippet = append(snippet, ellipsisUnits...)
	}
	snippet = append(snippet, tagged...)
	if window.end < len(units) {
		snippet = append(snippet, ellipsisUnits...)
	}
	return snippet, visible
}

type gapBuffer struct {
	units    []uint16
	gapStart int
	gapEnd   int
}

func newGapBuffer(content []uint16, room int) *gapBuffer {
	units := make([]uint16, len(content)+room)
	copy(units, content)
	return &gapBuffer{units: units, gapStart: len(content), gapEnd: len(units)}
}

func (b *gapBuffer) length() int {
	return len(b.units) - (b.gapEnd - b.gapStart)
}

func (b *gapBuffer) moveGap(position int) {
	if position < b.gapStart {
		moved := b.gapStart - position
		copy(b.units[b.gapEnd-moved:b.gapEnd], b.units[position:b.gapStart])
		b.gapStart = position
		b.gapEnd -= moved
		return
	}
	moved := position - b.gapStart
	copy(b.units[b.gapStart:b.gapStart+moved], b.units[b.gapEnd:b.gapEnd+moved])
	b.gapStart += moved
	b.gapEnd += moved
}

func (b *gapBuffer) insert(position int, piece []uint16) {
	if b.gapEnd-b.gapStart < len(piece) {
		grown := make([]uint16, len(b.units)+len(piece)+len(b.units)/2)
		copy(grown, b.units[:b.gapStart])
		suffix := len(b.units) - b.gapEnd
		copy(grown[len(grown)-suffix:], b.units[b.gapEnd:])
		b.gapEnd = len(grown) - suffix
		b.units = grown
	}
	b.moveGap(position)
	copy(b.units[b.gapStart:], piece)
	b.gapStart += len(piece)
}

func (b *gapBuffer) contents() []uint16 {
	contents := make([]uint16, 0, b.length())
	contents = append(contents, b.units[:b.gapStart]...)
	return append(contents, b.units[b.gapEnd:]...)
}

func insertTags(units []uint16, positions []span, preTag, postTag []uint16) []uint16 {
	descending := slices.Clone(positions)
	slices.SortStableFunc(descending, func(left, right span) int { return cmp.Compare(right.start, left.start) })
	buffer := newGapBuffer(units, len(positions)*(len(preTag)+len(postTag)))
	for _, position := range descending {
		length := buffer.length()
		start := min(max(position.start, 0), length)
		end := min(max(position.end, 0), length)
		if start > end {
			start, end = end, start
		}
		buffer.insert(end, postTag)
		buffer.insert(start, preTag)
	}
	return buffer.contents()
}
