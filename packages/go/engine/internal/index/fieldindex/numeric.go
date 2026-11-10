package fieldindex

import (
	"slices"
)

type numericEntry struct {
	value   float64
	ordinal uint32
}

type numericRemoval struct {
	value   float64
	ordinal uint32
	limit   int
}

type pendingRemovals struct {
	value  float64
	limits []int
	next   int
}

type Numeric struct {
	values   []float64
	ordinals []uint32
	pending  []numericEntry
	removals []numericRemoval
}

func NewNumeric() *Numeric {
	return &Numeric{}
}

func (index *Numeric) Insert(ordinal uint32, value float64) {
	index.pending = append(index.pending, numericEntry{value: value, ordinal: ordinal})
}

func (index *Numeric) Remove(ordinal uint32, value float64) {
	index.removals = append(index.removals, numericRemoval{value: value, ordinal: ordinal, limit: len(index.pending)})
	held := float64(len(index.values) + len(index.pending))
	if float64(len(index.removals)) >= max(pendingRemovalMergeFloor, held/pendingRemovalMergeDivisor) {
		index.Settle()
	}
}

func (index *Numeric) Settle() {
	if len(index.pending) == 0 && len(index.removals) == 0 {
		return
	}
	index.values, index.ordinals = settledColumns(index.values, index.ordinals, index.pending, index.removals)
	index.pending = nil
	index.removals = nil
}

func (index *Numeric) Clear() {
	index.values = nil
	index.ordinals = nil
	index.pending = nil
	index.removals = nil
}

func (index *Numeric) Load(values []float64, ordinals []uint32) {
	count := min(len(values), len(ordinals))
	index.values = slices.Clone(values[:count])
	index.ordinals = slices.Clone(ordinals[:count])
	index.pending = nil
	index.removals = nil
}

func (index *Numeric) Entries() ([]float64, []uint32) {
	values, ordinals := index.columns()
	return slices.Clone(values), slices.Clone(ordinals)
}

func (index *Numeric) EstimateBytes(documentCount int) int64 {
	return estimatedFieldBytes(documentCount)
}

func (index *Numeric) columns() ([]float64, []uint32) {
	if len(index.pending) == 0 && len(index.removals) == 0 {
		return index.values, index.ordinals
	}
	return settledColumns(
		slices.Clone(index.values),
		slices.Clone(index.ordinals),
		slices.Clone(index.pending),
		index.removals,
	)
}

func settledColumns(
	values []float64,
	ordinals []uint32,
	pending []numericEntry,
	removals []numericRemoval,
) ([]float64, []uint32) {
	if len(removals) > 0 {
		byOrdinal := groupedRemovals(removals)
		values, ordinals = withoutSortedRemovals(values, ordinals, lowestRemovedValue(removals), byOrdinal)
		pending = withoutPendingRemovals(pending, byOrdinal)
	}
	if len(pending) == 0 {
		return values, ordinals
	}
	slices.SortStableFunc(pending, compareEntryValues)
	return mergedColumns(values, ordinals, pending)
}

func compareEntryValues(left, right numericEntry) int {
	if left.value < right.value {
		return -1
	}
	if left.value > right.value {
		return 1
	}
	return 0
}

func lowestRemovedValue(removals []numericRemoval) float64 {
	lowest := removals[0].value
	for _, removal := range removals {
		if removal.value < lowest {
			lowest = removal.value
		}
	}
	return lowest
}

func removalsFor(byOrdinal map[uint32][]*pendingRemovals, ordinal uint32, value float64) *pendingRemovals {
	for _, key := range byOrdinal[ordinal] {
		if key.value == value {
			return key
		}
	}
	return nil
}

func groupedRemovals(removals []numericRemoval) map[uint32][]*pendingRemovals {
	byOrdinal := make(map[uint32][]*pendingRemovals)
	for _, removal := range removals {
		if existing := removalsFor(byOrdinal, removal.ordinal, removal.value); existing != nil {
			existing.limits = append(existing.limits, removal.limit)
			continue
		}
		key := &pendingRemovals{value: removal.value, limits: []int{removal.limit}}
		byOrdinal[removal.ordinal] = append(byOrdinal[removal.ordinal], key)
	}
	return byOrdinal
}

func withoutSortedRemovals(
	values []float64,
	ordinals []uint32,
	lowest float64,
	byOrdinal map[uint32][]*pendingRemovals,
) ([]float64, []uint32) {
	write := lowerBound(values, lowest)
	for read := write; read < len(values); read++ {
		key := removalsFor(byOrdinal, ordinals[read], values[read])
		if key != nil && key.next < len(key.limits) {
			key.next++
			continue
		}
		values[write] = values[read]
		ordinals[write] = ordinals[read]
		write++
	}
	return values[:write], ordinals[:write]
}

func withoutPendingRemovals(pending []numericEntry, byOrdinal map[uint32][]*pendingRemovals) []numericEntry {
	write := 0
	for read, entry := range pending {
		if key := removalsFor(byOrdinal, entry.ordinal, entry.value); key != nil {
			for key.next < len(key.limits) && key.limits[key.next] <= read {
				key.next++
			}
			if key.next < len(key.limits) {
				key.next++
				continue
			}
		}
		pending[write] = entry
		write++
	}
	return pending[:write]
}

func mergedColumns(values []float64, ordinals []uint32, pending []numericEntry) ([]float64, []uint32) {
	mainLength := len(values)
	total := mainLength + len(pending)
	values = slices.Grow(values, len(pending))[:total]
	ordinals = slices.Grow(ordinals, len(pending))[:total]
	left := mainLength - 1
	right := len(pending) - 1
	for write := total - 1; right >= 0; write-- {
		if left >= 0 && values[left] > pending[right].value {
			values[write] = values[left]
			ordinals[write] = ordinals[left]
			left--
			continue
		}
		values[write] = pending[right].value
		ordinals[write] = pending[right].ordinal
		right--
	}
	return values, ordinals
}

func lowerBound(values []float64, value float64) int {
	low, high := 0, len(values)
	for low < high {
		middle := int(uint(low+high) >> 1)
		if values[middle] < value {
			low = middle + 1
		} else {
			high = middle
		}
	}
	return low
}

func upperBound(values []float64, value float64) int {
	low, high := 0, len(values)
	for low < high {
		middle := int(uint(low+high) >> 1)
		if values[middle] <= value {
			low = middle + 1
		} else {
			high = middle
		}
	}
	return low
}
