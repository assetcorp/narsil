package fields

import (
	"strings"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

type Set struct {
	limits      Limits
	fields      []schema.Field
	numeric     map[string]*Numeric
	booleans    map[string]*Boolean
	enums       map[string]*Enum
	geos        map[string]*Geo
	sizes       map[string]*Numeric
	patterns    map[string]*Pattern
	stored      map[string]*Stored
	storedOrder []string
	sorts       *SortColumns
}

func NewSet(fields []schema.Field, limits Limits) (*Set, error) {
	if err := limits.validate(); err != nil {
		return nil, err
	}
	return &Set{
		limits:   limits,
		fields:   append([]schema.Field(nil), fields...),
		numeric:  map[string]*Numeric{},
		booleans: map[string]*Boolean{},
		enums:    map[string]*Enum{},
		geos:     map[string]*Geo{},
		sizes:    map[string]*Numeric{},
		patterns: map[string]*Pattern{},
		stored:   map[string]*Stored{},
	}, nil
}

func KeepsValueSize(base schema.BaseFieldType) bool {
	return base == schema.BaseString || base == schema.BaseVerbatim || strings.HasSuffix(string(base), "[]")
}

func ValueSizeOf(value any) float64 {
	if list, isList := value.([]any); isList {
		return float64(len(list))
	}
	if text, isText := value.(string); isText && text == "" {
		return 0
	}
	return 1
}

func (s *Set) Numeric(path string) *Numeric { return s.numeric[path] }
func (s *Set) Boolean(path string) *Boolean { return s.booleans[path] }
func (s *Set) Enum(path string) *Enum       { return s.enums[path] }
func (s *Set) Geo(path string) *Geo         { return s.geos[path] }
func (s *Set) Sizes(path string) *Numeric   { return s.sizes[path] }
func (s *Set) Pattern(path string) *Pattern { return s.patterns[path] }
func (s *Set) Stored(path string) *Stored   { return s.stored[path] }
func (s *Set) SortColumns() *SortColumns    { return s.sorts }
func (s *Set) StoredFields() []string       { return append([]string(nil), s.storedOrder...) }

func (s *Set) fieldOf(path string) (schema.Field, bool) {
	for _, field := range s.fields {
		if field.Path == path {
			return field, true
		}
	}
	return schema.Field{}, false
}

func (s *Set) Present(path string) []uint32 {
	field, declared := s.fieldOf(path)
	if !declared {
		return nil
	}
	switch field.Base {
	case schema.BaseNumber:
		if index := s.numeric[path]; index != nil {
			return index.Present()
		}
	case schema.BaseBoolean:
		if index := s.booleans[path]; index != nil {
			return index.Present()
		}
	case schema.BaseEnum:
		if index := s.enums[path]; index != nil {
			return index.Present()
		}
	case schema.BaseGeopoint:
		if index := s.geos[path]; index != nil {
			return index.Present()
		}
	default:
		if index := s.sizes[path]; index != nil && KeepsValueSize(field.Base) {
			return index.Present()
		}
	}
	return nil
}

func (s *Set) EnsureStored(path string, capacity uint32, valueAt func(ordinal uint32) (any, bool)) (*Stored, error) {
	if held := s.stored[path]; held != nil {
		return held, nil
	}
	stored, err := NewStored(path, s.limits)
	if err != nil {
		return nil, err
	}
	if err := stored.Backfill(capacity, valueAt); err != nil {
		stored.Release()
		return nil, err
	}
	s.stored[path] = stored
	s.storedOrder = append(s.storedOrder, path)
	return stored, nil
}

func (s *Set) listCapable(path string) bool {
	field, declared := s.fieldOf(path)
	return !declared || strings.HasSuffix(string(field.Base), "[]")
}

func (s *Set) HoldsSort(path string, mode core.SortMode) bool {
	return s.sorts != nil && s.sorts.Column(path, s.listCapable(path), mode) != nil
}

func (s *Set) EnsureSort(path string, mode core.SortMode, capacity uint32, liveOrdinals []uint32,
	valueAt func(ordinal uint32) (any, bool)) (*SortColumn, error) {
	if err := checkSortMode(path, mode); err != nil {
		return nil, err
	}
	listCapable := s.listCapable(path)
	if s.sorts != nil {
		if held := s.sorts.Column(path, listCapable, mode); held != nil {
			return held, nil
		}
	}
	stored, err := s.EnsureStored(path, capacity, valueAt)
	if err != nil {
		return nil, err
	}
	if s.sorts == nil {
		sorts, err := NewSortColumns(s.limits, capacity, liveOrdinals)
		if err != nil {
			return nil, err
		}
		s.sorts = sorts
	}
	return s.sorts.Ensure(path, listCapable, mode, stored, capacity)
}

func (s *Set) Settle(capacity uint32) error {
	if capacity > s.limits.MaxOrdinals {
		return s.limits.checkOrdinal(capacity)
	}
	var first error
	keep := func(err error) {
		if first == nil {
			first = err
		}
	}
	for _, field := range s.fields {
		path := field.Path
		if index := s.numeric[path]; index != nil {
			keep(index.Settle(capacity))
		}
		if index := s.booleans[path]; index != nil {
			keep(index.Settle(capacity))
		}
		if index := s.enums[path]; index != nil {
			keep(index.Settle(capacity))
		}
		if index := s.geos[path]; index != nil {
			keep(index.Settle(capacity))
		}
		if index := s.sizes[path]; index != nil {
			keep(index.Settle(capacity))
		}
		if index := s.patterns[path]; index != nil {
			keep(index.Settle())
		}
	}
	if s.sorts != nil {
		keep(s.sorts.Settle(capacity))
	}
	return first
}

func (s *Set) RegionBytes() uint64 {
	bytes := uint64(0)
	for _, field := range s.fields {
		path := field.Path
		if index := s.numeric[path]; index != nil {
			bytes += index.RegionBytes()
		}
		if index := s.booleans[path]; index != nil {
			bytes += index.RegionBytes()
		}
		if index := s.enums[path]; index != nil {
			bytes += index.RegionBytes()
		}
		if index := s.geos[path]; index != nil {
			bytes += index.RegionBytes()
		}
		if index := s.sizes[path]; index != nil {
			bytes += index.RegionBytes()
		}
		if index := s.patterns[path]; index != nil {
			bytes += index.RegionBytes()
		}
	}
	for _, path := range s.storedOrder {
		bytes += s.stored[path].RegionBytes()
	}
	if s.sorts != nil {
		bytes += s.sorts.RegionBytes()
	}
	return bytes
}

func (s *Set) Release() {
	for _, index := range s.numeric {
		index.Release()
	}
	for _, index := range s.booleans {
		index.Release()
	}
	for _, index := range s.enums {
		index.Release()
	}
	for _, index := range s.geos {
		index.Release()
	}
	for _, index := range s.sizes {
		index.Release()
	}
	for _, index := range s.patterns {
		index.Release()
	}
	for _, stored := range s.stored {
		stored.Release()
	}
	if s.sorts != nil {
		s.sorts.Release()
	}
	clear(s.numeric)
	clear(s.booleans)
	clear(s.enums)
	clear(s.geos)
	clear(s.sizes)
	clear(s.patterns)
	clear(s.stored)
	s.storedOrder, s.sorts = nil, nil
}

func refuseOrdinal(ordinal uint32) error {
	return narsilerr.New(narsilerr.CodeConfigInvalid, "a field index write names the same ordinal as its removal",
		map[string]any{"ordinal": float64(ordinal)})
}
