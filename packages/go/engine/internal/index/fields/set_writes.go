package fields

import "github.com/assetcorp/narsil/packages/go/engine/internal/schema"

type fieldValue struct {
	field schema.Field
	value any
}

func (s *Set) presentValues(document map[string]any) []fieldValue {
	values := make([]fieldValue, 0, len(s.fields))
	for _, field := range s.fields {
		value, found := nestedValue(document, field.Path)
		if presentValue(value, found) {
			values = append(values, fieldValue{field: field, value: value})
		}
	}
	return values
}

type storedWrite struct {
	changes []StoredChange
	plan    storedPlan
}

func (s *Set) planStored(removed *uint32, written *uint32, document map[string]any) ([]storedWrite, error) {
	writes := make([]storedWrite, len(s.storedOrder))
	for at, path := range s.storedOrder {
		changes := make([]StoredChange, 0, 2)
		if removed != nil && (written == nil || *removed != *written) {
			changes = append(changes, StoredChange{Ordinal: *removed})
		}
		if written != nil {
			value, found := nestedValue(document, path)
			changes = append(changes, StoredChange{Ordinal: *written, Value: value, Present: found})
		}
		plan, err := s.stored[path].plan(changes)
		if err != nil {
			return nil, err
		}
		writes[at] = storedWrite{changes: changes, plan: plan}
	}
	for at, path := range s.storedOrder {
		if err := s.stored[path].reserve(writes[at].plan); err != nil {
			return nil, err
		}
	}
	return writes, nil
}

func (s *Set) applyStored(writes []storedWrite) error {
	var first error
	for at, path := range s.storedOrder {
		if err := s.stored[path].applyPlan(writes[at].changes, writes[at].plan); err != nil && first == nil {
			first = err
		}
	}
	return first
}

func (s *Set) Insert(ordinal, capacity uint32, document map[string]any) error {
	if err := s.limits.checkOrdinal(ordinal); err != nil {
		return err
	}
	values := s.presentValues(document)
	if err := s.validateAll(values); err != nil {
		return err
	}
	plans, err := s.planStored(nil, &ordinal, document)
	if err != nil {
		return err
	}
	if err := s.prepareInserts(ordinal, values); err != nil {
		return err
	}
	first := s.applyInserts(ordinal, values)
	if err := s.applyStored(plans); err != nil && first == nil {
		first = err
	}
	if s.sorts != nil {
		if err := s.sorts.Record(ordinal, capacity); err != nil && first == nil {
			first = err
		}
	}
	return first
}

func (s *Set) Remove(ordinal uint32, document map[string]any) error {
	values := s.presentValues(document)
	if err := s.validateAll(values); err != nil {
		return err
	}
	plans, err := s.planStored(&ordinal, nil, nil)
	if err != nil {
		return err
	}
	first := s.applyRemovals(ordinal, values)
	if err := s.applyStored(plans); err != nil && first == nil {
		first = err
	}
	if s.sorts != nil {
		s.sorts.Forget(ordinal)
	}
	return first
}

func (s *Set) Replace(previous, ordinal, capacity uint32, before, after map[string]any) error {
	if previous == ordinal {
		return refuseOrdinal(ordinal)
	}
	if err := s.limits.checkOrdinal(ordinal); err != nil {
		return err
	}
	removed, written := s.presentValues(before), s.presentValues(after)
	if err := s.validateAll(removed); err != nil {
		return err
	}
	if err := s.validateAll(written); err != nil {
		return err
	}
	plans, err := s.planStored(&previous, &ordinal, after)
	if err != nil {
		return err
	}
	if err := s.prepareInserts(ordinal, written); err != nil {
		return err
	}
	first := s.applyRemovals(previous, removed)
	if s.sorts != nil {
		s.sorts.Forget(previous)
	}
	if err := s.applyInserts(ordinal, written); err != nil && first == nil {
		first = err
	}
	if err := s.applyStored(plans); err != nil && first == nil {
		first = err
	}
	if s.sorts != nil {
		if err := s.sorts.Record(ordinal, capacity); err != nil && first == nil {
			first = err
		}
	}
	return first
}

func (s *Set) Update(ordinal, capacity uint32, before, after map[string]any) error {
	if err := s.limits.checkOrdinal(ordinal); err != nil {
		return err
	}
	changes := make([]fieldChange, 0, len(s.fields))
	for _, field := range s.fields {
		if field.IsWordIndexed() {
			continue
		}
		oldValue, oldFound := nestedValue(before, field.Path)
		newValue, newFound := nestedValue(after, field.Path)
		change := fieldChange{field: field, oldPresent: presentValue(oldValue, oldFound), newPresent: presentValue(newValue, newFound),
			oldValue: oldValue, newValue: newValue}
		if unchangedValue(oldValue, oldFound, newValue, newFound) {
			continue
		}
		changes = append(changes, change)
	}
	if err := s.validateChanges(changes); err != nil {
		return err
	}
	plans, err := s.planStored(nil, &ordinal, after)
	if err != nil {
		return err
	}
	if err := s.prepareChanges(ordinal, changes); err != nil {
		return err
	}
	first := s.applyChanges(ordinal, changes)
	if err := s.applyStored(plans); err != nil && first == nil {
		first = err
	}
	if s.sorts != nil {
		if err := s.sorts.Record(ordinal, capacity); err != nil && first == nil {
			first = err
		}
	}
	return first
}
