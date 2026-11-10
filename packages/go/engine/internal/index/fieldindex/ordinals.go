package fieldindex

import (
	"math"
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/bitset"
)

const vacantOrdinal = math.MaxUint32

type insertionOrder struct {
	ordinals []uint32
	live     int
}

func (order *insertionOrder) push(ordinal uint32) uint32 {
	order.ordinals = append(order.ordinals, ordinal)
	order.live++
	return uint32(len(order.ordinals) - 1)
}

func (order *insertionOrder) vacate(position uint32) {
	if int(position) >= len(order.ordinals) || order.ordinals[position] == vacantOrdinal {
		return
	}
	order.ordinals[position] = vacantOrdinal
	order.live--
}

func (order *insertionOrder) crowded() bool {
	vacancies := len(order.ordinals) - order.live
	return vacancies >= vacancyCompactionFloor && vacancies > order.live
}

func (order *insertionOrder) compact(moved func(ordinal, position uint32)) {
	write := 0
	for _, ordinal := range order.ordinals {
		if ordinal == vacantOrdinal {
			continue
		}
		order.ordinals[write] = ordinal
		moved(ordinal, uint32(write))
		write++
	}
	order.ordinals = order.ordinals[:write]
	if cap(order.ordinals) > 2*write {
		order.ordinals = slices.Clone(order.ordinals)
	}
}

func (order *insertionOrder) appendLive(destination []uint32) []uint32 {
	for _, ordinal := range order.ordinals {
		if ordinal != vacantOrdinal {
			destination = append(destination, ordinal)
		}
	}
	return destination
}

func (order *insertionOrder) setInto(into bitset.Bits) {
	for _, ordinal := range order.ordinals {
		if ordinal != vacantOrdinal {
			into.Set(ordinal)
		}
	}
}

func (order *insertionOrder) countMatched(matched bitset.Bits) int {
	count := 0
	for _, ordinal := range order.ordinals {
		if ordinal != vacantOrdinal && matched.Has(ordinal) {
			count++
		}
	}
	return count
}

func grownPositions(positions []uint32, ordinal uint32) []uint32 {
	needed := int(ordinal) + 1
	if needed <= len(positions) {
		return positions
	}
	return append(positions, make([]uint32, needed-len(positions))...)
}

func estimatedFieldBytes(documentCount int) int64 {
	return int64(documentCount) * fieldEntryOverheadBytes
}
