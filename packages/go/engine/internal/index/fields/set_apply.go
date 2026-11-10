package fields

import (
	"unicode/utf8"

	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

func (s *Set) validateValue(field schema.Field, value any) error {
	path := field.Path
	switch field.Base {
	case schema.BaseNumber:
		_, err := finiteNumber(path, value, -1)
		return err
	case schema.BaseBoolean:
		_, err := booleanOf(path, value, -1)
		return err
	case schema.BaseEnum:
		_, err := textOf(path, value, -1)
		return err
	case schema.BaseString, schema.BaseVerbatim:
		text, err := textOf(path, value, -1)
		if err != nil {
			return err
		}
		return s.checkPatternLength(field, text)
	case schema.BaseGeopoint:
		_, err := geopointOf(path, value)
		return err
	case schema.BaseNumberList, schema.BaseBooleanList, schema.BaseEnumList, schema.BaseStringList, schema.BaseVerbatimList:
		return s.validateList(field, value)
	}
	return nil
}

func (s *Set) validateList(field schema.Field, value any) error {
	list, err := listOf(field.Path, value)
	if err != nil {
		return err
	}
	if uint64(len(list)) > uint64(s.limits.MaxEntries) {
		return capacityExceeded("values of field "+field.Path, uint64(len(list)), uint64(s.limits.MaxEntries))
	}
	for index, element := range list {
		var failure error
		switch field.Base {
		case schema.BaseNumberList:
			_, failure = finiteNumber(field.Path, element, index)
		case schema.BaseBooleanList:
			_, failure = booleanOf(field.Path, element, index)
		default:
			var text string
			if text, failure = textOf(field.Path, element, index); failure == nil {
				failure = s.checkPatternLength(field, text)
			}
		}
		if failure != nil {
			return failure
		}
	}
	return nil
}

func (s *Set) checkPatternLength(field schema.Field, text string) error {
	limit := int(s.limits.PatternValueLimit)
	if !field.Pattern || len(text) <= limit || utf8.RuneCountInString(text) <= limit {
		return nil
	}
	return invalidValue(field.Path, "is longer than the pattern value limit of this index",
		map[string]any{"limit": float64(limit)})
}

func (s *Set) validateAll(values []fieldValue) error {
	for _, entry := range values {
		if err := s.validateValue(entry.field, entry.value); err != nil {
			return err
		}
	}
	return nil
}

func elementsOf(value any) []any {
	if list, isList := value.([]any); isList {
		return list
	}
	return []any{value}
}

type createdIndexes []func()

func ensureIndex[T any](indexes map[string]*T, path string, create func(Limits) (*T, error), limits Limits,
	release func(*T), created *createdIndexes) error {
	if indexes[path] != nil {
		return nil
	}
	index, err := create(limits)
	if err != nil {
		return err
	}
	indexes[path] = index
	*created = append(*created, func() {
		release(index)
		delete(indexes, path)
	})
	return nil
}

func (created createdIndexes) drop() {
	for at := len(created) - 1; at >= 0; at-- {
		created[at]()
	}
}

func (s *Set) ensureIndexes(field schema.Field, created *createdIndexes) error {
	path, limits := field.Path, s.limits
	var err error
	switch field.Base {
	case schema.BaseNumber, schema.BaseNumberList:
		err = ensureIndex(s.numeric, path, NewNumeric, limits, (*Numeric).Release, created)
	case schema.BaseBoolean, schema.BaseBooleanList:
		err = ensureIndex(s.booleans, path, NewBoolean, limits, (*Boolean).Release, created)
	case schema.BaseEnum, schema.BaseEnumList:
		err = ensureIndex(s.enums, path, NewEnum, limits, (*Enum).Release, created)
	case schema.BaseGeopoint:
		err = ensureIndex(s.geos, path, NewGeo, limits, (*Geo).Release, created)
	}
	if err == nil && KeepsValueSize(field.Base) {
		err = ensureIndex(s.sizes, path, NewNumeric, limits, (*Numeric).Release, created)
	}
	if err == nil && field.Pattern {
		err = ensureIndex(s.patterns, path, NewPattern, limits, (*Pattern).Release, created)
	}
	return err
}

func (s *Set) prepareInsert(ordinal uint32, field schema.Field, value any, created *createdIndexes) error {
	if err := s.ensureIndexes(field, created); err != nil {
		return err
	}
	path := field.Path
	if KeepsValueSize(field.Base) {
		if err := s.sizes[path].checkInsert(ordinal, 1); err != nil {
			return err
		}
	}
	if field.Pattern && holdsTextValue(value) {
		pattern := s.patterns[path]
		pattern.collectKeys(value)
		if needed := pattern.postingTotal + uint64(len(pattern.keys)); needed > uint64(s.limits.MaxEntries) {
			return capacityExceeded("pattern postings", needed, uint64(s.limits.MaxEntries))
		}
	}
	elements := elementsOf(value)
	switch field.Base {
	case schema.BaseNumber, schema.BaseNumberList:
		return s.numeric[path].checkInsert(ordinal, uint64(len(elements)))
	case schema.BaseEnum, schema.BaseEnumList:
		return s.enums[path].checkElements(ordinal, elements)
	}
	return s.limits.checkOrdinal(ordinal)
}

func (s *Set) prepareInserts(ordinal uint32, values []fieldValue) error {
	var created createdIndexes
	for _, entry := range values {
		if err := s.prepareInsert(ordinal, entry.field, entry.value, &created); err != nil {
			created.drop()
			return err
		}
	}
	for _, entry := range values {
		if index := s.booleans[entry.field.Path]; index != nil && isBooleanBase(entry.field.Base) {
			if err := index.reserveFor(ordinal); err != nil {
				created.drop()
				return err
			}
		}
	}
	return nil
}

func isBooleanBase(base schema.BaseFieldType) bool {
	return base == schema.BaseBoolean || base == schema.BaseBooleanList
}

func (s *Set) applyInsert(ordinal uint32, field schema.Field, value any) error {
	path := field.Path
	if KeepsValueSize(field.Base) {
		s.sizes[path].insert(ordinal, ValueSizeOf(value))
	}
	if field.Pattern && holdsTextValue(value) {
		pattern := s.patterns[path]
		pattern.collectKeys(value)
		pattern.add(ordinal)
	}
	switch field.Base {
	case schema.BaseNumber, schema.BaseNumberList:
		for _, element := range elementsOf(value) {
			number, _ := numberOf(element)
			s.numeric[path].insert(ordinal, number)
		}
	case schema.BaseBoolean, schema.BaseBooleanList:
		for _, element := range elementsOf(value) {
			flag, _ := element.(bool)
			s.booleans[path].insert(ordinal, flag)
		}
	case schema.BaseEnum, schema.BaseEnumList:
		for _, element := range elementsOf(value) {
			text, _ := element.(string)
			s.enums[path].insert(ordinal, text)
		}
	case schema.BaseGeopoint:
		point, _ := geopointOf(path, value)
		return s.geos[path].insert(ordinal, point.lat, point.lon)
	}
	return nil
}

func (s *Set) applyInserts(ordinal uint32, values []fieldValue) error {
	var first error
	for _, entry := range values {
		if err := s.applyInsert(ordinal, entry.field, entry.value); err != nil && first == nil {
			first = err
		}
	}
	return first
}

func (s *Set) applyRemoval(ordinal uint32, field schema.Field, value any) error {
	path := field.Path
	var first error
	keep := func(err error) {
		if err != nil && first == nil {
			first = err
		}
	}
	if index := s.sizes[path]; index != nil && KeepsValueSize(field.Base) {
		keep(index.Remove(ordinal, ValueSizeOf(value)))
	}
	if pattern := s.patterns[path]; pattern != nil && field.Pattern && holdsTextValue(value) {
		pattern.collectKeys(value)
		pattern.remove(ordinal)
	}
	switch field.Base {
	case schema.BaseNumber, schema.BaseNumberList:
		if index := s.numeric[path]; index != nil {
			for _, element := range elementsOf(value) {
				number, _ := numberOf(element)
				keep(index.Remove(ordinal, number))
			}
		}
	case schema.BaseBoolean, schema.BaseBooleanList:
		if index := s.booleans[path]; index != nil {
			for _, element := range elementsOf(value) {
				flag, _ := element.(bool)
				index.Remove(ordinal, flag)
			}
		}
	case schema.BaseEnum, schema.BaseEnumList:
		if index := s.enums[path]; index != nil {
			for _, element := range elementsOf(value) {
				text, _ := element.(string)
				index.Remove(ordinal, text)
			}
		}
	case schema.BaseGeopoint:
		if index := s.geos[path]; index != nil {
			keep(index.Remove(ordinal))
		}
	}
	return first
}

func (s *Set) applyRemovals(ordinal uint32, values []fieldValue) error {
	var first error
	for _, entry := range values {
		if err := s.applyRemoval(ordinal, entry.field, entry.value); err != nil && first == nil {
			first = err
		}
	}
	return first
}
