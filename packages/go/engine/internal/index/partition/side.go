package partition

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/fieldindex"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/geo"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partialwords"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/pattern"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/postings"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

type side struct {
	postings     *postings.Index
	documents    documentStore
	statistics   statistics
	surfaces     surfaceRegistry
	fieldNames   []string
	fieldNumbers map[string]uint16
	numbers      map[string]*fieldindex.Numeric
	booleans     map[string]*fieldindex.Boolean
	enums        map[string]*fieldindex.Enum
	geopoints    map[string]*geo.Index
	sizes        map[string]*fieldindex.Numeric
	touched      touchedIndexes
	frozen       []*frozenSub
	partial      *partialwords.GrowingTable
	patterns     map[string]*pattern.Growing
}

func (s *side) successor() *side {
	next := newSide()
	next.partial.AdoptFields(s.partial.Fields())
	return next
}

func (s *side) patternIndex(path string) *pattern.Growing {
	index := s.patterns[path]
	if index == nil {
		index = pattern.NewGrowing()
		s.patterns[path] = index
	}
	return index
}

type touchedIndexes struct {
	numbers   map[*fieldindex.Numeric]struct{}
	geopoints map[*geo.Index]struct{}
}

func newSide() *side {
	return &side{
		postings:     postings.New(),
		documents:    newDocumentStore(),
		statistics:   newStatistics(),
		surfaces:     newSurfaceRegistry(),
		fieldNumbers: map[string]uint16{},
		numbers:      map[string]*fieldindex.Numeric{},
		booleans:     map[string]*fieldindex.Boolean{},
		enums:        map[string]*fieldindex.Enum{},
		geopoints:    map[string]*geo.Index{},
		sizes:        map[string]*fieldindex.Numeric{},
		touched:      touchedIndexes{numbers: map[*fieldindex.Numeric]struct{}{}, geopoints: map[*geo.Index]struct{}{}},
		partial:      partialwords.NewGrowingTable(),
		patterns:     map[string]*pattern.Growing{},
	}
}

func (s *side) fieldNumber(path string) uint16 {
	if number, found := s.fieldNumbers[path]; found {
		return number
	}
	number := uint16(len(s.fieldNames))
	s.fieldNames = append(s.fieldNames, path)
	s.fieldNumbers[path] = number
	return number
}

func (s *side) numericIndex(indexes map[string]*fieldindex.Numeric, path string) *fieldindex.Numeric {
	index := indexes[path]
	if index == nil {
		index = fieldindex.NewNumeric()
		indexes[path] = index
	}
	s.touched.numbers[index] = struct{}{}
	return index
}

func (s *side) booleanIndex(path string) *fieldindex.Boolean {
	index := s.booleans[path]
	if index == nil {
		index = fieldindex.NewBoolean()
		s.booleans[path] = index
	}
	return index
}

func (s *side) enumIndex(path string) *fieldindex.Enum {
	index := s.enums[path]
	if index == nil {
		index = fieldindex.NewEnum()
		s.enums[path] = index
	}
	return index
}

func (s *side) geoIndex(path string) *geo.Index {
	index := s.geopoints[path]
	if index == nil {
		index = geo.NewIndex()
		s.geopoints[path] = index
	}
	s.touched.geopoints[index] = struct{}{}
	return index
}

func keepsValueSize(base schema.BaseFieldType) bool {
	return base == schema.BaseString || base == schema.BaseVerbatim || len(base) > 2 && base[len(base)-2:] == "[]"
}

func valueSizeOf(value any) float64 {
	if items, isList := value.([]any); isList {
		return float64(len(items))
	}
	if value == "" {
		return 0
	}
	return 1
}

func (s *side) ensureFieldIndex(path string, base schema.BaseFieldType) {
	switch base {
	case schema.BaseNumber, schema.BaseNumberList:
		s.numericIndex(s.numbers, path)
	case schema.BaseBoolean, schema.BaseBooleanList:
		s.booleanIndex(path)
	case schema.BaseEnum, schema.BaseEnumList:
		s.enumIndex(path)
	case schema.BaseGeopoint:
		s.geoIndex(path)
	}
}

func (s *side) indexValues(ordinal uint32, document map[string]any, fields []schema.Field) {
	for _, field := range fields {
		value, present := presentValue(document, field.Path)
		if !present {
			continue
		}
		if keepsValueSize(field.Base) {
			s.numericIndex(s.sizes, field.Path).Insert(ordinal, valueSizeOf(value))
		}
		s.ensureFieldIndex(field.Path, field.Base)
		if field.Pattern {
			s.patternIndex(field.Path).Add(ordinal, value)
		}
		s.applyValue(ordinal, field, value, true)
	}
}

func (s *side) removeValues(ordinal uint32, document map[string]any, fields []schema.Field) {
	for _, field := range fields {
		value, present := presentValue(document, field.Path)
		if !present {
			continue
		}
		if keepsValueSize(field.Base) {
			if index := s.sizes[field.Path]; index != nil {
				s.touched.numbers[index] = struct{}{}
				index.Remove(ordinal, valueSizeOf(value))
			}
		}
		if index := s.patterns[field.Path]; field.Pattern && index != nil {
			index.Remove(ordinal, value)
		}
		s.applyValue(ordinal, field, value, false)
	}
}

func (s *side) applyValue(ordinal uint32, field schema.Field, value any, inserting bool) {
	switch field.Base {
	case schema.BaseNumber, schema.BaseNumberList:
		if index := s.numbers[field.Path]; index != nil {
			s.touched.numbers[index] = struct{}{}
			forEachValue(value, func(item any) {
				if number, isNumber := item.(float64); isNumber {
					if inserting {
						index.Insert(ordinal, number)
					} else {
						index.Remove(ordinal, number)
					}
				}
			})
		}
	case schema.BaseBoolean, schema.BaseBooleanList:
		if index := s.booleans[field.Path]; index != nil {
			forEachValue(value, func(item any) {
				if flag, isBool := item.(bool); isBool {
					if inserting {
						index.Insert(ordinal, flag)
					} else {
						index.Remove(ordinal, flag)
					}
				}
			})
		}
	case schema.BaseEnum, schema.BaseEnumList:
		if index := s.enums[field.Path]; index != nil {
			forEachValue(value, func(item any) {
				if written, isString := item.(string); isString {
					if inserting {
						index.Insert(ordinal, written)
					} else {
						index.Remove(ordinal, written)
					}
				}
			})
		}
	case schema.BaseGeopoint:
		s.applyGeopoint(ordinal, field.Path, value, inserting)
	}
}

func (s *side) applyGeopoint(ordinal uint32, path string, value any, inserting bool) {
	index := s.geopoints[path]
	if index == nil {
		return
	}
	s.touched.geopoints[index] = struct{}{}
	if !inserting {
		index.Remove(ordinal)
		return
	}
	point, isObject := value.(map[string]any)
	if !isObject {
		return
	}
	lat, latFound := point["lat"].(float64)
	lon, lonFound := point["lon"].(float64)
	if latFound && lonFound {
		index.Insert(ordinal, lat, lon)
	}
}

func forEachValue(value any, visit func(item any)) {
	if items, isList := value.([]any); isList {
		for _, item := range items {
			visit(item)
		}
		return
	}
	visit(value)
}

func (s *side) settle() {
	for index := range s.touched.numbers {
		index.Settle()
	}
	for index := range s.touched.geopoints {
		index.Settle()
	}
	clear(s.touched.numbers)
	clear(s.touched.geopoints)
}
