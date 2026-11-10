package growing

import (
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type stringTable struct {
	header    []uint32
	heads     []uint32
	slots     column[int32]
	offset    column[uint32]
	length    column[uint32]
	next      column[uint32]
	units     column[uint16]
	occupied  uint64
	accounted uint64
}

type stringCapacity struct {
	offsets uint64
	units   uint64
	slots   uint64
	rehash  bool
}

func newStringTable(capacity uint64) (*stringTable, error) {
	slots := uint64(2)
	for slots <= capacity {
		slots *= termRegionGrowthFactor
	}
	table := &stringTable{header: make([]uint32, termTableHeaderWords), heads: make([]uint32, firstUnitHeads)}
	table.header[headerSlotCapacity] = uint32(slots)
	if err := table.grow(stringCapacity{offsets: capacity, units: termUnitsStartCapacity, slots: slots}); err != nil {
		table.release()
		return nil, err
	}
	return table, nil
}

func (t *stringTable) view() core.TermTable {
	return core.TermTable{
		Header:        t.header,
		Slots:         t.slots.values,
		TermOffset:    t.offset.values,
		TermLength:    t.length.values,
		FirstUnitNext: t.next.values,
		FirstUnitHead: t.heads,
		Units:         t.units.values,
	}
}

func (t *stringTable) count() uint64 {
	return uint64(t.header[headerCount])
}

func (t *stringTable) live() uint64 {
	return uint64(t.header[headerLiveCount])
}

func (t *stringTable) unitsUsed() uint64 {
	return uint64(t.header[headerUnitsUsed])
}

func (t *stringTable) textAt(ordinal uint64) ([]uint16, bool) {
	if ordinal >= t.offset.len() || ordinal >= t.length.len() {
		return nil, false
	}
	start := uint64(t.offset.values[ordinal])
	end := start + uint64(t.length.values[ordinal])
	if end > t.units.len() {
		return nil, false
	}
	return t.units.values[start:end], true
}

func (t *stringTable) find(text []uint16) (uint64, bool) {
	slots := t.slots.values
	if len(slots) == 0 {
		return 0, false
	}
	mask := uint64(len(slots) - 1)
	count := t.count()
	used := t.unitsUsed()
	slot := uint64(hashUnits(text)) & mask
	for scanned := 0; scanned < len(slots); scanned++ {
		entry := slots[slot]
		if entry == 0 {
			return 0, false
		}
		ordinal := uint64(entry) - 1
		if entry > 0 && ordinal < count && ordinal < t.length.len() && uint64(t.length.values[ordinal]) == uint64(len(text)) {
			start := uint64(t.offset.values[ordinal])
			if start <= used && uint64(len(text)) <= used-start && slices.Equal(t.units.values[start:start+uint64(len(text))], text) {
				return ordinal, true
			}
		}
		slot = (slot + 1) & mask
	}
	return 0, false
}

func capacityFor(current, needed uint64) uint64 {
	return max(needed, min(lastOffset, current*termRegionGrowthFactor))
}

func (t *stringTable) prepareCapacity(terms, units uint64) (stringCapacity, error) {
	count := t.count()
	if terms < count || terms > lastSlotOrdinal+1 || units < t.unitsUsed() || units > lastOffset {
		return stringCapacity{}, narsilerr.New(narsilerr.CodePartitionCapacityExceeded,
			"a keyword segment term does not fit its table regions",
			map[string]any{"terms": float64(terms), "units": float64(units)})
	}
	slotCount := t.slots.len()
	occupied := min(slotCount, t.occupied+(count-min(count, t.accounted)))
	added := terms - count
	plan := stringCapacity{offsets: t.offset.len(), units: t.units.len(), slots: slotCount}
	if terms > plan.offsets {
		plan.offsets = min(lastSlotOrdinal+1, capacityFor(plan.offsets, terms))
	}
	if units > plan.units {
		plan.units = capacityFor(plan.units, units)
	}
	if (occupied+added)*termSlotLoadDenominator >= slotCount*termSlotLoadNumerator {
		live := t.live() + added
		capacity := slotCount
		for live*termSlotLoadDenominator >= capacity*termSlotLoadNumerator {
			capacity *= termRegionGrowthFactor
			if capacity > lastSlotCapacity {
				return stringCapacity{}, narsilerr.New(narsilerr.CodePartitionCapacityExceeded,
					"a keyword segment term table exceeds its slot layout", map[string]any{"terms": float64(terms)})
			}
		}
		plan.slots = capacity
		plan.rehash = true
	}
	return plan, nil
}

func (t *stringTable) apply(plan stringCapacity) error {
	count := t.count()
	if err := t.grow(plan); err != nil {
		return err
	}
	occupied := min(t.slots.len(), t.occupied+(count-min(count, t.accounted)))
	if plan.rehash {
		if err := t.rehash(plan.slots); err != nil {
			return err
		}
		occupied = t.live()
	}
	t.header[headerSlotCapacity] = uint32(t.slots.len())
	t.occupied = occupied
	t.accounted = count
	return nil
}

func (t *stringTable) grow(plan stringCapacity) error {
	if plan.offsets > t.offset.len() {
		for _, held := range []*column[uint32]{&t.offset, &t.length, &t.next} {
			if err := held.resize(plan.offsets); err != nil {
				return err
			}
		}
	}
	if plan.units > t.units.len() {
		if err := t.units.resize(plan.units); err != nil {
			return err
		}
	}
	if t.slots.region == nil {
		return t.slots.resize(plan.slots)
	}
	return nil
}

func (t *stringTable) rehash(capacity uint64) error {
	held := slices.Clone(t.slots.values)
	if err := t.slots.resize(capacity); err != nil {
		return err
	}
	slots := t.slots.values
	clear(slots)
	mask := capacity - 1
	for _, entry := range held {
		if entry <= 0 {
			continue
		}
		text, ok := t.textAt(uint64(entry) - 1)
		if !ok {
			continue
		}
		slot := uint64(hashUnits(text)) & mask
		for slots[slot] != 0 {
			slot = (slot + 1) & mask
		}
		slots[slot] = entry
	}
	return nil
}

func (t *stringTable) trim(minimum uint64) error {
	count := max(minimum, t.count())
	capacity := uint64(2)
	for count*termSlotLoadDenominator >= capacity*termSlotLoadNumerator {
		capacity *= termRegionGrowthFactor
	}
	if capacity < t.slots.len() {
		if err := t.rehash(capacity); err != nil {
			return err
		}
	}
	for _, held := range []*column[uint32]{&t.offset, &t.length, &t.next} {
		if err := held.resize(min(count, held.len())); err != nil {
			return err
		}
	}
	if err := t.units.resize(min(t.units.len(), max(termUnitsStartCapacity, t.unitsUsed()))); err != nil {
		return err
	}
	t.header[headerSlotCapacity] = uint32(t.slots.len())
	t.acceptCompaction()
	return nil
}

func (t *stringTable) acceptCompaction() {
	t.occupied = t.live()
	t.accounted = t.count()
}

func (t *stringTable) bytes() uint64 {
	return uint64(len(t.header))*4 + uint64(len(t.heads))*4 + t.slots.bytes() + t.offset.bytes() +
		t.length.bytes() + t.next.bytes() + t.units.bytes()
}

func (t *stringTable) release() {
	t.slots.release()
	t.offset.release()
	t.length.release()
	t.next.release()
	t.units.release()
}
