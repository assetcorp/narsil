package fields

import (
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	narsiltext "github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type enumValue struct {
	text     string
	units    []uint16
	ordinals *orderedSet
}

type Enum struct {
	limits         Limits
	values         map[string]*enumValue
	unitCount      uint64
	postingCount   uint64
	units          array[uint16]
	offsets        array[uint32]
	postingOffsets array[uint32]
	postings       array[uint32]
	suffixOrder    array[uint32]
	built          []uint64
	dirty          bool
	present        presence
}

func NewEnum(limits Limits) (*Enum, error) {
	if err := limits.validate(); err != nil {
		return nil, err
	}
	entries := uint64(limits.MaxEntries)
	return &Enum{
		limits:         limits,
		values:         map[string]*enumValue{},
		units:          newArray[uint16]("enum units", uint64(limits.MaxTextUnits)),
		offsets:        newArray[uint32]("enum offsets", entries+1),
		postingOffsets: newArray[uint32]("enum posting offsets", entries+1),
		postings:       newArray[uint32]("enum postings", entries),
		suffixOrder:    newArray[uint32]("enum suffix order", entries),
		built:          []uint64{0, 1, 1, 0, 0},
		dirty:          true,
		present:        newPresence("enum present bitset", limits.MaxOrdinals),
	}, nil
}

func (e *Enum) checkInsert(ordinal uint32, value string) error {
	if err := e.limits.checkOrdinal(ordinal); err != nil {
		return err
	}
	if needed := e.postingCount + 1; needed > uint64(e.limits.MaxEntries) {
		return capacityExceeded("enum postings", needed, uint64(e.limits.MaxEntries))
	}
	if _, known := e.values[value]; !known {
		if needed := e.unitCount + uint64(narsiltext.UTF16Length(value)); needed > uint64(e.limits.MaxTextUnits) {
			return capacityExceeded("enum units", needed, uint64(e.limits.MaxTextUnits))
		}
	}
	return nil
}

func (e *Enum) checkElements(ordinal uint32, elements []any) error {
	if err := e.limits.checkOrdinal(ordinal); err != nil {
		return err
	}
	if needed := e.postingCount + uint64(len(elements)); needed > uint64(e.limits.MaxEntries) {
		return capacityExceeded("enum postings", needed, uint64(e.limits.MaxEntries))
	}
	units := e.unitCount
	for _, element := range elements {
		text, _ := element.(string)
		if _, known := e.values[text]; !known {
			units += uint64(narsiltext.UTF16Length(text))
		}
	}
	if units > uint64(e.limits.MaxTextUnits) {
		return capacityExceeded("enum units", units, uint64(e.limits.MaxTextUnits))
	}
	return nil
}

func (e *Enum) Insert(ordinal uint32, value string) error {
	if err := checkText("enum", value, -1); err != nil {
		return err
	}
	if err := e.checkInsert(ordinal, value); err != nil {
		return err
	}
	e.insert(ordinal, value)
	return nil
}

func (e *Enum) insert(ordinal uint32, value string) {
	held, known := e.values[value]
	if !known {
		held = &enumValue{text: value, units: narsiltext.EncodeUTF16(value), ordinals: newOrderedSet()}
		e.values[value] = held
		e.unitCount += uint64(len(held.units))
	}
	if held.ordinals.add(ordinal) {
		e.present.invalidate()
		e.dirty = true
		e.postingCount++
	}
}

func (e *Enum) Remove(ordinal uint32, value string) {
	held, known := e.values[value]
	if !known || !held.ordinals.remove(ordinal) {
		return
	}
	e.present.invalidate()
	e.dirty = true
	e.postingCount--
	if held.ordinals.size() > 0 {
		return
	}
	delete(e.values, value)
	e.unitCount -= uint64(len(held.units))
}

func compareSuffix(left, right []uint16) int {
	length := min(len(left), len(right))
	for at := 1; at <= length; at++ {
		difference := int(left[len(left)-at]) - int(right[len(right)-at])
		if difference != 0 {
			return difference
		}
	}
	return len(left) - len(right)
}

func (e *Enum) sortedValues() []*enumValue {
	sorted := make([]*enumValue, 0, len(e.values))
	for _, held := range e.values {
		sorted = append(sorted, held)
	}
	slices.SortFunc(sorted, func(left, right *enumValue) int {
		return narsiltext.CompareUTF16Units(left.text, right.text)
	})
	return sorted
}

func (e *Enum) reserve(count uint64) error {
	if err := e.units.reserve(e.unitCount, 1); err != nil {
		return err
	}
	if err := e.offsets.reserve(count+1, 1); err != nil {
		return err
	}
	if err := e.postingOffsets.reserve(count+1, 1); err != nil {
		return err
	}
	if err := e.postings.reserve(e.postingCount, 1); err != nil {
		return err
	}
	return e.suffixOrder.reserve(count, 1)
}

func (e *Enum) build() error {
	sorted := e.sortedValues()
	count := uint64(len(sorted))
	if err := e.reserve(count); err != nil {
		return err
	}
	units := e.units.prefix(e.unitCount)
	offsets := e.offsets.prefix(count + 1)
	postingOffsets := e.postingOffsets.prefix(count + 1)
	postings := e.postings.prefix(e.postingCount)
	suffixOrder := e.suffixOrder.prefix(count)
	offsets[0], postingOffsets[0] = 0, 0
	unit, posting := uint32(0), uint32(0)
	for at, held := range sorted {
		copy(units[unit:], held.units)
		unit += uint32(len(held.units))
		held.ordinals.each(func(ordinal uint32) {
			postings[posting] = ordinal
			posting++
		})
		offsets[at+1], postingOffsets[at+1] = unit, posting
		suffixOrder[at] = uint32(at)
	}
	slices.SortFunc(suffixOrder, func(left, right uint32) int {
		return compareSuffix(sorted[left].units, sorted[right].units)
	})
	e.built = []uint64{e.unitCount, count + 1, count + 1, e.postingCount, count}
	e.dirty = false
	return nil
}

func (e *Enum) Settle(capacity uint32) error {
	if e.dirty {
		if err := e.build(); err != nil {
			return err
		}
	}
	return e.present.rebuild(capacity, func(bits []uint32) {
		for _, held := range e.values {
			held.ordinals.each(func(ordinal uint32) { setBit(bits, ordinal) })
		}
	})
}

func (e *Enum) Index() *core.EnumIndex {
	if e.offsets.capacity == 0 {
		return &core.EnumIndex{Offsets: []uint32{0}, PostingOffsets: []uint32{0}}
	}
	return &core.EnumIndex{
		Units:          e.units.prefix(e.built[0]),
		Offsets:        e.offsets.prefix(e.built[1]),
		PostingOffsets: e.postingOffsets.prefix(e.built[2]),
		Postings:       e.postings.prefix(e.built[3]),
		SuffixOrder:    e.suffixOrder.prefix(e.built[4]),
	}
}

func (e *Enum) Values() []string {
	sorted := e.sortedValues()
	texts := make([]string, len(sorted))
	for at, held := range sorted {
		texts[at] = held.text
	}
	return texts
}

func (e *Enum) Present() []uint32 {
	return e.present.view()
}

func (e *Enum) Count() uint64 {
	return e.postingCount
}

func (e *Enum) RegionBytes() uint64 {
	return e.units.bytes() + e.offsets.bytes() + e.postingOffsets.bytes() + e.postings.bytes() +
		e.suffixOrder.bytes() + e.present.bytes()
}

func (e *Enum) HostBytes() uint64 {
	bytes := uint64(0)
	for _, held := range e.values {
		bytes += uint64(len(held.text)) + uint64(cap(held.units))*2 + held.ordinals.bytes() + hashEntryBytes
	}
	return bytes
}

func (e *Enum) Release() {
	e.units.release()
	e.offsets.release()
	e.postingOffsets.release()
	e.postings.release()
	e.suffixOrder.release()
	e.present.release()
	clear(e.values)
	e.unitCount, e.postingCount = 0, 0
	e.built = []uint64{0, 1, 1, 0, 0}
	e.dirty = true
}
