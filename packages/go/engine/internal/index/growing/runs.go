package growing

import (
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type runTable struct {
	header     []uint32
	slots      column[int32]
	runs       column[uint32]
	listStart  column[uint32]
	listLength column[uint32]
	listClass  column[uint8]
	members    column[uint32]
	allocation []uint32
	freeHeads  []uint32
}

func newRunTable() (*runTable, error) {
	table := &runTable{header: make([]uint32, termTableHeaderWords), allocation: make([]uint32, allocationWords), freeHeads: freeHeadsFilled()}
	slots := uint64(runTableStartCapacity * termRegionGrowthFactor)
	err := table.slots.resize(slots)
	if err == nil {
		err = table.resizeRuns(runTableStartCapacity)
	}
	if err == nil {
		err = table.members.resize(runMemberStartCapacity)
	}
	if err != nil {
		table.release()
		return nil, err
	}
	table.header[headerSlotCapacity] = uint32(slots)
	return table, nil
}

func (t *runTable) resizeRuns(capacity uint64) error {
	if err := t.runs.resize(capacity * runPoints); err != nil {
		return err
	}
	for _, held := range []*column[uint32]{&t.listStart, &t.listLength} {
		if err := held.resize(capacity); err != nil {
			return err
		}
	}
	return t.listClass.resize(capacity)
}

func runTableRefusal(count uint64) error {
	return narsilerr.New(narsilerr.CodePartitionCapacityExceeded, "a keyword segment run table exceeds its slot layout",
		map[string]any{"runs": float64(count)})
}

func (t *runTable) reserve(count, members uint64) error {
	if count < uint64(t.header[headerCount]) || count > lastRunCount {
		return runTableRefusal(count)
	}
	slotCapacity := t.slots.len()
	for count*termSlotLoadDenominator >= slotCapacity*termSlotLoadNumerator {
		slotCapacity *= termRegionGrowthFactor
		if slotCapacity > lastSlotCapacity {
			return runTableRefusal(count)
		}
	}
	if slotCapacity > t.slots.len() {
		if err := t.rehash(slotCapacity); err != nil {
			return err
		}
	}
	if count > t.listStart.len() {
		if err := t.resizeRuns(min(lastRunCount, max(count, t.listStart.len()*termRegionGrowthFactor))); err != nil {
			return err
		}
	}
	if members > t.members.len() {
		capacity, err := grownCapacity(t.members.len(), members)
		if err != nil {
			return err
		}
		t.members.clearFrom(uint64(t.allocation[allocationEnd]))
		if err := t.members.resize(capacity); err != nil {
			return err
		}
	}
	t.header[headerSlotCapacity] = uint32(t.slots.len())
	return nil
}

func (t *runTable) trim() error {
	count := max(runTableStartCapacity, uint64(t.header[headerCount]))
	capacity := uint64(runTableStartCapacity * termRegionGrowthFactor)
	for count*termSlotLoadDenominator >= capacity*termSlotLoadNumerator {
		capacity *= termRegionGrowthFactor
	}
	if capacity < t.slots.len() {
		if err := t.rehash(capacity); err != nil {
			return err
		}
	}
	if err := t.runs.resize(min(t.runs.len(), count*runPoints)); err != nil {
		return err
	}
	for _, held := range []*column[uint32]{&t.listStart, &t.listLength} {
		if err := held.resize(min(held.len(), count)); err != nil {
			return err
		}
	}
	if err := t.listClass.resize(min(t.listClass.len(), count)); err != nil {
		return err
	}
	if err := t.members.resize(min(t.members.len(), max(runMemberStartCapacity, uint64(t.allocation[allocationEnd])))); err != nil {
		return err
	}
	t.header[headerSlotCapacity] = uint32(t.slots.len())
	return nil
}

func (t *runTable) rehash(capacity uint64) error {
	held := slices.Clone(t.slots.values)
	if err := t.slots.resize(capacity); err != nil {
		return err
	}
	slots := t.slots.values
	clear(slots)
	mask := capacity - 1
	runs := t.runs.values
	for _, entry := range held {
		if entry <= 0 {
			continue
		}
		at := (uint64(entry) - 1) * runPoints
		if at+runPoints > uint64(len(runs)) {
			continue
		}
		slot := uint64(hashRun(runs[at:at+runPoints])) & mask
		for slots[slot] != 0 {
			slot = (slot + 1) & mask
		}
		slots[slot] = entry
	}
	return nil
}

func (t *runTable) view() core.RunTable {
	return core.RunTable{
		Header:     t.header,
		Slots:      t.slots.values,
		Runs:       t.runs.values,
		ListStart:  t.listStart.values,
		ListLength: t.listLength.values,
		ListClass:  t.listClass.values,
		Members:    t.members.values,
		Allocator:  core.SliceAllocator{Allocation: t.allocation, FreeHeads: t.freeHeads, SliceCapacities: sliceCapacities},
	}
}

func (t *runTable) bytes() uint64 {
	return uint64(len(t.header)+len(t.allocation)+len(t.freeHeads))*4 + t.slots.bytes() + t.runs.bytes() +
		t.listStart.bytes() + t.listLength.bytes() + t.listClass.bytes() + t.members.bytes()
}

func (t *runTable) release() {
	t.slots.release()
	t.runs.release()
	t.listStart.release()
	t.listLength.release()
	t.listClass.release()
	t.members.release()
}
