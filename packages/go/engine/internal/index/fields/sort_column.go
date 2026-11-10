package fields

import "github.com/assetcorp/narsil/packages/go/engine/internal/core"

type SortColumn struct {
	field          string
	mode           core.SortMode
	stored         StoredSource
	store          sortStore
	dictKinds      array[uint8]
	dictNumbers    array[float64]
	dictTextStart  array[uint32]
	dictTextLength array[uint32]
	dictUnits      array[uint16]
	ranks          array[int32]
	ordered        array[uint32]
	dirtyBits      array[uint32]
	valueCount     uint64
	dictUnitCount  uint64
	rankCount      uint64
	orderedCount   uint64
	dirtyWords     uint64
	capacity       uint64
	dirty          map[uint32]struct{}
}

type StoredSource interface {
	Values() *core.StoredValues
	Units() []uint16
}

type storedRegions struct {
	regions *core.StoredValueSlices
}

func (r storedRegions) Values() *core.StoredValues {
	return r.regions.Values()
}

func (r storedRegions) Units() []uint16 {
	return r.regions.Units
}

func StoredRegionsSource(regions *core.StoredValueSlices) StoredSource {
	return storedRegions{regions: regions}
}

func newSortColumn(field string, mode core.SortMode, stored StoredSource, limits Limits) *SortColumn {
	ordinals, units := uint64(limits.MaxOrdinals), uint64(limits.MaxTextUnits)
	return &SortColumn{
		field:          field,
		mode:           mode,
		stored:         stored,
		store:          newSortStore(limits),
		dictKinds:      newArray[uint8]("sort dictionary kinds", ordinals),
		dictNumbers:    newArray[float64]("sort dictionary numbers", ordinals),
		dictTextStart:  newArray[uint32]("sort dictionary text starts", ordinals),
		dictTextLength: newArray[uint32]("sort dictionary text lengths", ordinals),
		dictUnits:      newArray[uint16]("sort dictionary units", units),
		ranks:          newArray[int32]("sort ranks", ordinals),
		ordered:        newArray[uint32]("sort order", ordinals),
		dirtyBits:      newArray[uint32]("sort dirty bitset", bitsetWords(limits.MaxOrdinals)),
		dirty:          map[uint32]struct{}{},
	}
}

func (c *SortColumn) reduce(workspace *core.Workspace, ordinal uint32) (sortValue, error) {
	number := []float64{0}
	text := make([]uint32, sortStoredOutputTextWords)
	values := c.stored.Values()
	kind, err := workspace.SortValue(values, ordinal, c.mode, number, text)
	if err != nil {
		return sortValue{}, coreFailure("sortValue", err)
	}
	reduced := sortValue{kind: kind, number: number[0]}
	if kind == core.SortString {
		units := c.stored.Units()
		start, length := uint64(text[core.SortValueTextStartSlot]), uint64(text[core.SortValueTextLengthSlot])
		if start > uint64(len(units)) || length > uint64(len(units))-start {
			return sortValue{}, coreFailure("sortValue", &core.StatusError{Operation: "sortValue", Status: core.StatusInvalidArgument})
		}
		reduced.units = units[start : start+length]
	}
	return reduced, nil
}

func (c *SortColumn) record(workspace *core.Workspace, ordinal uint32) error {
	value, err := c.reduce(workspace, ordinal)
	if err != nil {
		return err
	}
	if err := c.store.set(ordinal, &value); err != nil {
		return err
	}
	c.dirty[ordinal] = struct{}{}
	return nil
}

func (c *SortColumn) forget(ordinal uint32) {
	c.store.clear(ordinal)
	delete(c.dirty, ordinal)
}

func (c *SortColumn) reserveOrder(capacity, present, unitCount uint64) error {
	steps := []func() error{
		func() error { return c.dictKinds.reserve(present, 1) },
		func() error { return c.dictNumbers.reserve(present, 1) },
		func() error { return c.dictTextStart.reserve(present, 1) },
		func() error { return c.dictTextLength.reserve(present, 1) },
		func() error { return c.dictUnits.reserve(unitCount, 1) },
		func() error { return c.ranks.reserve(capacity, 1) },
		func() error { return c.ordered.reserve(present, 1) },
	}
	for _, step := range steps {
		if err := step(); err != nil {
			return err
		}
	}
	return nil
}

func (c *SortColumn) build(workspace *core.Workspace, live []uint32, capacity uint64) error {
	if err := c.store.grow(capacity); err != nil {
		return err
	}
	current := c.store.values(capacity)
	present, unitCount := uint64(0), uint64(0)
	forEachBit(live, func(ordinal uint32) {
		if uint64(ordinal) >= capacity || core.SortKind(current.Kinds[ordinal]) == core.SortMissing {
			return
		}
		present++
		if core.SortKind(current.Kinds[ordinal]) == core.SortString {
			unitCount += uint64(current.TextLength[ordinal])
		}
	})
	if err := c.reserveOrder(capacity, present, unitCount); err != nil {
		return err
	}
	output := core.SortOrderOutput{
		Values: core.SortValues{
			Kinds: c.dictKinds.prefix(present), Numbers: c.dictNumbers.prefix(present),
			TextStart: c.dictTextStart.prefix(present), TextLength: c.dictTextLength.prefix(present),
			Units: c.dictUnits.prefix(unitCount),
		},
		Ranks:   c.ranks.prefix(capacity),
		Ordered: c.ordered.prefix(present),
		Dirty:   make([]uint32, bitsetWords(uint32(capacity))),
		Counts:  make([]uint32, sortOrderCountWords),
	}
	clear(output.Values.Kinds)
	clear(output.Values.Numbers)
	clear(output.Values.TextStart)
	clear(output.Values.TextLength)
	clear(output.Values.Units)
	clear(output.Ranks)
	clear(output.Ordered)
	if err := workspace.BuildSortOrder(&current, live, &output); err != nil {
		return coreFailure("buildSortOrder", err)
	}
	c.valueCount = uint64(output.Counts[core.SortOrderDistinctSlot])
	c.dictUnitCount, c.rankCount, c.orderedCount = unitCount, capacity, present
	clear(c.dirty)
	return nil
}

func (c *SortColumn) settleRegions(capacity uint64) error {
	if err := c.store.grow(capacity); err != nil {
		return err
	}
	words := bitsetWords(uint32(capacity))
	if err := c.dirtyBits.reserve(words, 1); err != nil {
		return err
	}
	view := c.dirtyBits.prefix(words)
	clear(view)
	for ordinal := range c.dirty {
		setBit(view, ordinal)
	}
	c.dirtyWords = words
	c.capacity = capacity
	return nil
}

func (c *SortColumn) Column() *core.SortColumn {
	return &core.SortColumn{
		Current: c.store.values(c.capacity),
		Values: core.SortValues{
			Kinds: c.dictKinds.prefix(c.valueCount), Numbers: c.dictNumbers.prefix(c.valueCount),
			TextStart: c.dictTextStart.prefix(c.valueCount), TextLength: c.dictTextLength.prefix(c.valueCount),
			Units: c.dictUnits.prefix(c.dictUnitCount),
		},
		Ranks:   c.ranks.prefix(c.rankCount),
		Ordered: c.ordered.prefix(c.orderedCount),
		Dirty:   c.dirtyBits.prefix(c.dirtyWords),
	}
}

func (c *SortColumn) Field() string {
	return c.field
}

func (c *SortColumn) Mode() core.SortMode {
	return c.mode
}

func (c *SortColumn) DirtyCount() int {
	return len(c.dirty)
}

func (c *SortColumn) RegionBytes() uint64 {
	return c.store.bytes() + c.dictKinds.bytes() + c.dictNumbers.bytes() + c.dictTextStart.bytes() +
		c.dictTextLength.bytes() + c.dictUnits.bytes() + c.ranks.bytes() + c.ordered.bytes() + c.dirtyBits.bytes()
}

func (c *SortColumn) Release() {
	c.store.release()
	for _, release := range []func(){c.dictKinds.release, c.dictNumbers.release, c.dictTextStart.release,
		c.dictTextLength.release, c.dictUnits.release, c.ranks.release, c.ordered.release, c.dirtyBits.release} {
		release()
	}
	clear(c.dirty)
}
