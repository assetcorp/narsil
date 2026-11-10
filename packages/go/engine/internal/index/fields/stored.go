package fields

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type StoredChange struct {
	Ordinal uint32
	Value   any
	Present bool
}

type Stored struct {
	path       string
	limits     Limits
	shapes     array[uint8]
	starts     array[uint32]
	kinds      array[uint8]
	numbers    array[float64]
	textStart  array[uint32]
	textLength array[uint32]
	units      array[uint16]
	encoded    array[uint8]
	ordinals   uint64
	elements   uint64
	usedUnits  uint64
	usedBytes  uint64
	liveUnits  uint64
	liveBytes  uint64
}

func NewStored(path string, limits Limits) (*Stored, error) {
	if err := limits.validate(); err != nil {
		return nil, err
	}
	ordinals, entries := uint64(limits.MaxOrdinals), uint64(limits.MaxEntries)
	stored := &Stored{
		path:       path,
		limits:     limits,
		shapes:     newArray[uint8]("stored shapes", ordinals),
		starts:     newArray[uint32]("stored starts", ordinals+1),
		kinds:      newArray[uint8]("stored kinds", entries),
		numbers:    newArray[float64]("stored numbers", entries),
		textStart:  newArray[uint32]("stored text starts", entries),
		textLength: newArray[uint32]("stored text lengths", entries),
		units:      newArray[uint16]("stored units", uint64(limits.MaxTextUnits)),
		encoded:    newArray[uint8]("stored bytes", uint64(limits.MaxEncodedBytes)),
	}
	if err := stored.starts.reserveExactly(1); err != nil {
		return nil, err
	}
	return stored, nil
}

type storedPlan struct {
	entries  []storedEntry
	ordinals uint64
	capacity uint64
	units    uint64
	bytes    uint64
	compact  bool
}

func (s *Stored) elementsAt(ordinal uint32) uint64 {
	if uint64(ordinal) >= s.ordinals {
		return 0
	}
	starts := s.starts.prefix(s.ordinals + 1)
	return uint64(starts[ordinal+1] - starts[ordinal])
}

func (s *Stored) plan(changes []StoredChange) (storedPlan, error) {
	plan := storedPlan{entries: make([]storedEntry, len(changes)), ordinals: s.ordinals, capacity: s.elements}
	elements := s.elements
	seen := make(map[uint32]struct{}, len(changes))
	for at, change := range changes {
		if err := s.limits.checkOrdinal(change.Ordinal); err != nil {
			return plan, err
		}
		if _, repeated := seen[change.Ordinal]; repeated {
			return plan, narsilerr.New(narsilerr.CodeConfigInvalid,
				"one stored-values change set names an ordinal twice", map[string]any{"ordinal": float64(change.Ordinal)})
		}
		seen[change.Ordinal] = struct{}{}
		entry, err := buildStoredEntry(s.path, change.Value, change.Present, s.limits)
		if err != nil {
			return plan, err
		}
		plan.entries[at] = entry
		plan.ordinals = max(plan.ordinals, uint64(change.Ordinal)+1)
		elements = elements + entry.elements() - s.elementsAt(change.Ordinal)
		plan.capacity = max(plan.capacity, elements)
		plan.units += uint64(len(entry.units))
		plan.bytes += uint64(len(entry.encoded))
	}
	if plan.capacity > uint64(s.limits.MaxEntries) {
		return plan, capacityExceeded("stored values", plan.capacity, uint64(s.limits.MaxEntries))
	}
	plan.compact = (s.usedUnits > storedPayloadInitialCapacity && s.usedUnits-s.liveUnits > s.liveUnits) ||
		(s.usedBytes > storedPayloadInitialCapacity && s.usedBytes-s.liveBytes > s.liveBytes)
	return plan, nil
}

func (s *Stored) reserve(plan storedPlan) error {
	usedUnits, usedBytes := s.usedUnits, s.usedBytes
	if plan.compact {
		usedUnits, usedBytes = s.liveUnits, s.liveBytes
	}
	if needed := usedUnits + plan.units; needed > uint64(s.limits.MaxTextUnits) {
		return capacityExceeded("stored units", needed, uint64(s.limits.MaxTextUnits))
	}
	if needed := usedBytes + plan.bytes; needed > uint64(s.limits.MaxEncodedBytes) {
		return capacityExceeded("stored bytes", needed, uint64(s.limits.MaxEncodedBytes))
	}
	steps := []func() error{
		func() error { return s.shapes.reserve(plan.ordinals, storedValuesInitialCapacity) },
		func() error { return s.starts.reserve(plan.ordinals+1, storedValuesInitialCapacity) },
		func() error { return s.kinds.reserve(plan.capacity, storedValuesInitialCapacity) },
		func() error { return s.numbers.reserve(plan.capacity, storedValuesInitialCapacity) },
		func() error { return s.textStart.reserve(plan.capacity, storedValuesInitialCapacity) },
		func() error { return s.textLength.reserve(plan.capacity, storedValuesInitialCapacity) },
		func() error { return s.units.reserve(usedUnits+plan.units, storedPayloadInitialCapacity) },
		func() error { return s.encoded.reserve(usedBytes+plan.bytes, storedPayloadInitialCapacity) },
	}
	for _, step := range steps {
		if err := step(); err != nil {
			return err
		}
	}
	return nil
}

func (s *Stored) Apply(changes []StoredChange) error {
	plan, err := s.plan(changes)
	if err != nil {
		return err
	}
	return s.applyPlan(changes, plan)
}

func (s *Stored) applyPlan(changes []StoredChange, plan storedPlan) error {
	if err := s.reserve(plan); err != nil {
		return err
	}
	if plan.compact {
		s.compactPayload()
	}
	for at, change := range changes {
		s.replace(change.Ordinal, &plan.entries[at])
	}
	return nil
}

func (s *Stored) compactPayload() {
	kinds := s.kinds.prefix(s.elements)
	textStart := s.textStart.prefix(s.elements)
	textLength := s.textLength.prefix(s.elements)
	units := s.units.prefix(s.usedUnits)
	encoded := s.encoded.prefix(s.usedBytes)
	liveUnits := make([]uint16, 0, s.liveUnits)
	liveBytes := make([]uint8, 0, s.liveBytes)
	for at, kind := range kinds {
		start, end := textStart[at], textStart[at]+textLength[at]
		switch kind {
		case storedKindString:
			textStart[at] = uint32(len(liveUnits))
			liveUnits = append(liveUnits, units[start:end]...)
		case storedKindOther:
			textStart[at] = uint32(len(liveBytes))
			liveBytes = append(liveBytes, encoded[start:end]...)
		}
	}
	copy(units, liveUnits)
	copy(encoded, liveBytes)
	s.usedUnits, s.usedBytes = uint64(len(liveUnits)), uint64(len(liveBytes))
}

func (s *Stored) replace(ordinal uint32, entry *storedEntry) {
	starts := s.starts.all()
	if uint64(ordinal) >= s.ordinals {
		for at := s.ordinals; at < uint64(ordinal)+2; at++ {
			starts[at] = uint32(s.elements)
		}
		s.ordinals = uint64(ordinal) + 1
	}
	kinds, numbers := s.kinds.all(), s.numbers.all()
	textStart, textLength := s.textStart.all(), s.textLength.all()
	start, end := uint64(starts[ordinal]), uint64(starts[ordinal+1])
	for at := start; at < end; at++ {
		switch kinds[at] {
		case storedKindString:
			s.liveUnits -= uint64(textLength[at])
		case storedKindOther:
			s.liveBytes -= uint64(textLength[at])
		}
	}
	count := entry.elements()
	if count != end-start {
		target := start + count
		copy(kinds[target:], kinds[end:s.elements])
		copy(numbers[target:], numbers[end:s.elements])
		copy(textStart[target:], textStart[end:s.elements])
		copy(textLength[target:], textLength[end:s.elements])
		delta := uint32(count) - uint32(end-start)
		for at := uint64(ordinal) + 1; at <= s.ordinals; at++ {
			starts[at] += delta
		}
		s.elements = s.elements + count - (end - start)
	}
	s.shapes.all()[ordinal] = entry.shape
	copy(kinds[start:], entry.kinds)
	copy(numbers[start:], entry.numbers)
	copy(textLength[start:], entry.textLength)
	for at, kind := range entry.kinds {
		base := uint32(0)
		switch kind {
		case storedKindString:
			base = uint32(s.usedUnits)
		case storedKindOther:
			base = uint32(s.usedBytes)
		}
		textStart[start+uint64(at)] = entry.textStart[at] + base
	}
	copy(s.units.all()[s.usedUnits:], entry.units)
	copy(s.encoded.all()[s.usedBytes:], entry.encoded)
	s.usedUnits += uint64(len(entry.units))
	s.liveUnits += uint64(len(entry.units))
	s.usedBytes += uint64(len(entry.encoded))
	s.liveBytes += uint64(len(entry.encoded))
}

func (s *Stored) Backfill(capacity uint32, valueAt func(ordinal uint32) (any, bool)) error {
	if s.ordinals > 0 {
		return narsilerr.New(narsilerr.CodeConfigInvalid, "a stored-values column takes a backfill only while it is empty",
			map[string]any{"field": s.path})
	}
	if err := s.limits.checkOrdinal(max(capacity, 1) - 1); err != nil {
		return err
	}
	changes := make([]StoredChange, 0, capacity)
	for ordinal := range capacity {
		value, found := valueAt(ordinal)
		changes = append(changes, StoredChange{Ordinal: ordinal, Value: value, Present: found})
	}
	return s.Apply(changes)
}

func (s *Stored) Values() *core.StoredValues {
	return s.Slices().Values()
}

func (s *Stored) Slices() core.StoredValueSlices {
	return core.StoredValueSlices{
		Shapes:     s.shapes.prefix(s.ordinals),
		Starts:     s.starts.prefix(s.ordinals + 1),
		Kinds:      s.kinds.prefix(s.elements),
		Numbers:    s.numbers.prefix(s.elements),
		TextStart:  s.textStart.prefix(s.elements),
		TextLength: s.textLength.prefix(s.elements),
		Units:      s.units.prefix(s.usedUnits),
		Bytes:      s.encoded.prefix(s.usedBytes),
	}
}

func (s *Stored) Units() []uint16 {
	return s.units.prefix(s.usedUnits)
}

func (s *Stored) Path() string {
	return s.path
}

func (s *Stored) RegionBytes() uint64 {
	return s.shapes.bytes() + s.starts.bytes() + s.kinds.bytes() + s.numbers.bytes() + s.textStart.bytes() +
		s.textLength.bytes() + s.units.bytes() + s.encoded.bytes()
}

func (s *Stored) Release() {
	for _, release := range []func(){s.shapes.release, s.starts.release, s.kinds.release, s.numbers.release,
		s.textStart.release, s.textLength.release, s.units.release, s.encoded.release} {
		release()
	}
	s.ordinals, s.elements, s.usedUnits, s.usedBytes, s.liveUnits, s.liveBytes = 0, 0, 0, 0, 0, 0
}
