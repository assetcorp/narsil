package fields

import (
	"cmp"
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
)

type numericRemoval struct {
	value  float64
	limits []int
	next   int
}

type Numeric struct {
	limits          Limits
	values          array[float64]
	ordinals        array[uint32]
	length          uint64
	pendingValues   []float64
	pendingOrdinals []uint32
	removedOrdinals []uint32
	removedValues   []float64
	removedLimits   []int
	present         presence
}

func NewNumeric(limits Limits) (*Numeric, error) {
	if err := limits.validate(); err != nil {
		return nil, err
	}
	return &Numeric{
		limits:   limits,
		values:   newArray[float64]("numeric values", uint64(limits.MaxEntries)),
		ordinals: newArray[uint32]("numeric ordinals", uint64(limits.MaxEntries)),
		present:  newPresence("numeric present bitset", limits.MaxOrdinals),
	}, nil
}

func (n *Numeric) held() uint64 {
	return n.length + uint64(len(n.pendingValues))
}

func (n *Numeric) checkInsert(ordinal uint32, count uint64) error {
	if err := n.limits.checkOrdinal(ordinal); err != nil {
		return err
	}
	if needed := n.held() + count; needed > uint64(n.limits.MaxEntries) {
		return capacityExceeded("numeric entries", needed, uint64(n.limits.MaxEntries))
	}
	return nil
}

func (n *Numeric) insert(ordinal uint32, value float64) {
	n.present.invalidate()
	n.pendingValues = append(n.pendingValues, value)
	n.pendingOrdinals = append(n.pendingOrdinals, ordinal)
}

func (n *Numeric) Remove(ordinal uint32, value float64) error {
	n.present.invalidate()
	n.removedOrdinals = append(n.removedOrdinals, ordinal)
	n.removedValues = append(n.removedValues, value)
	n.removedLimits = append(n.removedLimits, len(n.pendingValues))
	removed := uint64(len(n.removedOrdinals))
	if removed >= pendingRemovalMergeFloor && removed*pendingRemovalMergeDivisor >= n.held() {
		return n.ensureSorted()
	}
	return nil
}

func (n *Numeric) removalsByOrdinal() (map[uint32][]*numericRemoval, float64) {
	removals := make(map[uint32][]*numericRemoval, len(n.removedOrdinals))
	lowest := n.removedValues[0]
	for at, ordinal := range n.removedOrdinals {
		value := n.removedValues[at]
		if value < lowest {
			lowest = value
		}
		held := removals[ordinal]
		matched := false
		for _, removal := range held {
			if removal.value == value {
				removal.limits = append(removal.limits, n.removedLimits[at])
				matched = true
				break
			}
		}
		if !matched {
			removals[ordinal] = append(held, &numericRemoval{value: value, limits: []int{n.removedLimits[at]}})
		}
	}
	return removals, lowest
}

func takeRemoval(removals map[uint32][]*numericRemoval, ordinal uint32, value float64, read int, pending bool) bool {
	for _, removal := range removals[ordinal] {
		if removal.value != value {
			continue
		}
		if pending {
			for removal.next < len(removal.limits) && removal.limits[removal.next] <= read {
				removal.next++
			}
		}
		if removal.next < len(removal.limits) {
			removal.next++
			return true
		}
		return false
	}
	return false
}

func lowerBound(values []float64, value float64) uint64 {
	low, high := 0, len(values)
	for low < high {
		middle := low + (high-low)/2
		if values[middle] < value {
			low = middle + 1
		} else {
			high = middle
		}
	}
	return uint64(low)
}

func (n *Numeric) applyRemovals() {
	removals, lowest := n.removalsByOrdinal()
	values := n.values.prefix(n.length)
	ordinals := n.ordinals.prefix(n.length)
	write := lowerBound(values, lowest)
	for read := write; read < n.length; read++ {
		if takeRemoval(removals, ordinals[read], values[read], int(read), false) {
			continue
		}
		values[write], ordinals[write] = values[read], ordinals[read]
		write++
	}
	n.length = write
	kept := 0
	for read := range n.pendingValues {
		if takeRemoval(removals, n.pendingOrdinals[read], n.pendingValues[read], read, true) {
			continue
		}
		n.pendingValues[kept], n.pendingOrdinals[kept] = n.pendingValues[read], n.pendingOrdinals[read]
		kept++
	}
	n.pendingValues, n.pendingOrdinals = n.pendingValues[:kept], n.pendingOrdinals[:kept]
	n.removedOrdinals, n.removedValues, n.removedLimits = n.removedOrdinals[:0], n.removedValues[:0], n.removedLimits[:0]
}

func (n *Numeric) ensureSorted() error {
	if len(n.removedOrdinals) > 0 {
		n.applyRemovals()
	}
	pending := uint64(len(n.pendingValues))
	if pending == 0 {
		return nil
	}
	total := n.length + pending
	if err := n.values.reserve(total, numericInitialCapacity); err != nil {
		return err
	}
	if err := n.ordinals.reserve(total, numericInitialCapacity); err != nil {
		return err
	}
	order := make([]uint32, pending)
	for at := range order {
		order[at] = uint32(at)
	}
	slices.SortStableFunc(order, func(left, right uint32) int {
		return cmp.Compare(n.pendingValues[left], n.pendingValues[right])
	})
	values := n.values.prefix(total)
	ordinals := n.ordinals.prefix(total)
	left := int64(n.length) - 1
	right := int64(pending) - 1
	write := int64(total) - 1
	for right >= 0 {
		next := order[right]
		if left >= 0 && values[left] > n.pendingValues[next] {
			values[write], ordinals[write] = values[left], ordinals[left]
			left--
		} else {
			values[write], ordinals[write] = n.pendingValues[next], n.pendingOrdinals[next]
			right--
		}
		write--
	}
	n.length = total
	n.pendingValues, n.pendingOrdinals = n.pendingValues[:0], n.pendingOrdinals[:0]
	return nil
}

func (n *Numeric) Settle(capacity uint32) error {
	if err := n.ensureSorted(); err != nil {
		return err
	}
	ordinals := n.ordinals.prefix(n.length)
	return n.present.rebuild(capacity, func(bits []uint32) {
		for _, ordinal := range ordinals {
			setBit(bits, ordinal)
		}
	})
}

func (n *Numeric) Index() *core.NumericIndex {
	return &core.NumericIndex{Values: n.values.prefix(n.length), Ordinals: n.ordinals.prefix(n.length)}
}

func (n *Numeric) Present() []uint32 {
	return n.present.view()
}

func (n *Numeric) RegionBytes() uint64 {
	return n.values.bytes() + n.ordinals.bytes() + n.present.bytes()
}

func (n *Numeric) Release() {
	n.values.release()
	n.ordinals.release()
	n.present.release()
	n.length = 0
	n.pendingValues, n.pendingOrdinals = nil, nil
	n.removedOrdinals, n.removedValues, n.removedLimits = nil, nil, nil
}
