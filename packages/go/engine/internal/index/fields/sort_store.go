package fields

import "github.com/assetcorp/narsil/packages/go/engine/internal/core"

type sortValue struct {
	kind   core.SortKind
	number float64
	units  []uint16
}

type sortStore struct {
	limits     Limits
	kinds      array[uint8]
	numbers    array[float64]
	textStart  array[uint32]
	textLength array[uint32]
	units      array[uint16]
	usedUnits  uint64
	liveUnits  uint64
}

func newSortStore(limits Limits) sortStore {
	ordinals := 2 * uint64(limits.MaxOrdinals)
	return sortStore{
		limits:     limits,
		kinds:      newArray[uint8]("sort kinds", ordinals),
		numbers:    newArray[float64]("sort numbers", ordinals),
		textStart:  newArray[uint32]("sort text starts", ordinals),
		textLength: newArray[uint32]("sort text lengths", ordinals),
		units:      newArray[uint16]("sort units", 2*uint64(limits.MaxTextUnits)),
	}
}

func (s *sortStore) grow(capacity uint64) error {
	if capacity <= s.kinds.capacity {
		return nil
	}
	next := max(capacity, s.kinds.capacity*2, sortValuesInitialCapacity)
	for _, reserve := range []func(uint64) error{s.kinds.reserveExactly, s.numbers.reserveExactly,
		s.textStart.reserveExactly, s.textLength.reserveExactly} {
		if err := reserve(next); err != nil {
			return err
		}
	}
	return nil
}

func (s *sortStore) compact() {
	kinds := s.kinds.all()
	textStart, textLength := s.textStart.all(), s.textLength.all()
	units := s.units.prefix(s.usedUnits)
	live := make([]uint16, 0, s.liveUnits)
	for ordinal, kind := range kinds {
		if core.SortKind(kind) != core.SortString {
			continue
		}
		start := textStart[ordinal]
		textStart[ordinal] = uint32(len(live))
		live = append(live, units[start:start+textLength[ordinal]]...)
	}
	copy(units, live)
	s.usedUnits = uint64(len(live))
}

func (s *sortStore) reserveText(length uint64) error {
	if s.usedUnits-s.liveUnits > s.liveUnits && s.usedUnits > sortTextInitialCapacity {
		s.compact()
	}
	needed := s.usedUnits + length
	if needed > uint64(s.limits.MaxTextUnits) {
		return capacityExceeded("sort units", needed, uint64(s.limits.MaxTextUnits))
	}
	return s.units.reserve(needed, sortTextInitialCapacity)
}

func (s *sortStore) prepare(ordinal uint32, value *sortValue) error {
	if err := s.grow(uint64(ordinal) + 1); err != nil {
		return err
	}
	if value.kind != core.SortString {
		return nil
	}
	length := uint64(len(value.units))
	isText := core.SortKind(s.kinds.all()[ordinal]) == core.SortString
	if isText && length <= uint64(s.textLength.all()[ordinal]) {
		return nil
	}
	return s.reserveText(length)
}

func (s *sortStore) set(ordinal uint32, value *sortValue) error {
	if err := s.prepare(ordinal, value); err != nil {
		return err
	}
	kinds, numbers := s.kinds.all(), s.numbers.all()
	textStart, textLength := s.textStart.all(), s.textLength.all()
	isText := core.SortKind(kinds[ordinal]) == core.SortString
	oldLength := uint64(0)
	if isText {
		oldLength = uint64(textLength[ordinal])
	}
	if value.kind == core.SortString {
		length := uint64(len(value.units))
		start := uint64(textStart[ordinal])
		if !isText || length > oldLength {
			start = s.usedUnits
			s.usedUnits += length
		}
		copy(s.units.all()[start:], value.units)
		textStart[ordinal] = uint32(start)
		textLength[ordinal] = uint32(length)
		kinds[ordinal] = uint8(core.SortString)
		s.liveUnits = s.liveUnits + length - oldLength
		return nil
	}
	s.liveUnits -= oldLength
	textStart[ordinal], textLength[ordinal] = 0, 0
	kinds[ordinal] = uint8(value.kind)
	numbers[ordinal] = 0
	if value.kind == core.SortNumber {
		numbers[ordinal] = value.number
	}
	return nil
}

func (s *sortStore) clear(ordinal uint32) {
	if uint64(ordinal) >= s.kinds.capacity {
		return
	}
	kinds := s.kinds.all()
	if core.SortKind(kinds[ordinal]) == core.SortString {
		s.liveUnits -= uint64(s.textLength.all()[ordinal])
	}
	kinds[ordinal] = uint8(core.SortMissing)
	s.textStart.all()[ordinal] = 0
	s.textLength.all()[ordinal] = 0
}

func (s *sortStore) values(capacity uint64) core.SortValues {
	return core.SortValues{
		Kinds:      s.kinds.prefix(capacity),
		Numbers:    s.numbers.prefix(capacity),
		TextStart:  s.textStart.prefix(capacity),
		TextLength: s.textLength.prefix(capacity),
		Units:      s.units.prefix(s.usedUnits),
	}
}

func (s *sortStore) bytes() uint64 {
	return s.kinds.bytes() + s.numbers.bytes() + s.textStart.bytes() + s.textLength.bytes() + s.units.bytes()
}

func (s *sortStore) release() {
	s.kinds.release()
	s.numbers.release()
	s.textStart.release()
	s.textLength.release()
	s.units.release()
	s.usedUnits, s.liveUnits = 0, 0
}
