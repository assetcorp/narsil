package filters

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/bitset"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

type evaluation struct {
	source   Source
	patterns PatternSearch
	types    map[string]schema.ParsedFieldType
	capacity int
	universe bitset.Bits
	present  map[string]bitset.Bits
}

func newEvaluation(filter *Filter, source Source) *evaluation {
	return &evaluation{
		source:   source,
		patterns: filter.patterns,
		types:    filter.types,
		capacity: source.Capacity(),
		present:  map[string]bitset.Bits{},
	}
}

func (e *evaluation) Source() Source {
	return e.source
}

func (e *evaluation) Capacity() int {
	return e.capacity
}

func (e *evaluation) none() bitset.Bits {
	return bitset.New(e.capacity)
}

func (e *evaluation) Universe() bitset.Bits {
	if e.universe == nil {
		e.universe = e.none()
		e.universe.OrWith(e.source.Live())
	}
	return e.universe
}

func (e *evaluation) Present(fieldPath string) bitset.Bits {
	if held, cached := e.present[fieldPath]; cached {
		return held
	}
	present := e.presentOf(fieldPath)
	e.present[fieldPath] = present
	return present
}

func keepsValueSize(field schema.ParsedFieldType) bool {
	return field.Base == schema.BaseString || field.Base == schema.BaseVerbatim || field.IsList()
}

func (e *evaluation) presentOf(fieldPath string) bitset.Bits {
	present := e.none()
	field, declared := e.types[fieldPath]
	if !declared {
		return present
	}
	switch field.Base {
	case schema.BaseNumber:
		if index := e.source.Numeric(fieldPath); index != nil {
			index.AllInto(present)
		}
	case schema.BaseBoolean:
		if index := e.source.Boolean(fieldPath); index != nil {
			index.AllInto(present)
		}
	case schema.BaseEnum:
		if index := e.source.Enum(fieldPath); index != nil {
			index.AllInto(present)
		}
	case schema.BaseGeopoint:
		if index := e.source.Geo(fieldPath); index != nil {
			index.ForEachDocument(present.Set)
		}
	default:
		if index := e.source.Sizes(fieldPath); index != nil && keepsValueSize(field) {
			index.AllInto(present)
		}
	}
	return present
}

func (e *evaluation) without(from, removed bitset.Bits) bitset.Bits {
	kept := from.Clone()
	kept.AndNotWith(removed)
	return kept
}

func (e *evaluation) complement(bits bitset.Bits) bitset.Bits {
	return e.without(e.Universe(), bits)
}

func (e *evaluation) holdingSomething(fieldPath string) bitset.Bits {
	sizes := e.source.Sizes(fieldPath)
	if sizes == nil {
		return e.Present(fieldPath)
	}
	empty := e.none()
	sizes.EqualInto(0, empty)
	return e.without(e.Present(fieldPath), empty)
}

type narrowing struct {
	bits     bitset.Bits
	narrowed bool
}

func (n *narrowing) narrow(matched bitset.Bits) {
	if !n.narrowed {
		n.bits = matched.Clone()
		n.narrowed = true
		return
	}
	n.bits.AndWith(matched)
}

func (e *evaluation) expression(validated *expression) (bitset.Bits, error) {
	var accepted narrowing
	for at := range validated.fields {
		if err := e.narrowByFieldTests(&validated.fields[at], accepted.narrow); err != nil {
			return nil, err
		}
	}
	for at := range validated.and {
		nested, err := e.expression(&validated.and[at])
		if err != nil {
			return nil, err
		}
		accepted.narrow(nested)
	}
	if len(validated.or) > 0 {
		union := e.none()
		for at := range validated.or {
			nested, err := e.expression(&validated.or[at])
			if err != nil {
				return nil, err
			}
			union.OrWith(nested)
		}
		accepted.narrow(union)
	}
	if validated.not != nil {
		excluded, err := e.expression(validated.not)
		if err != nil {
			return nil, err
		}
		accepted.narrow(e.complement(excluded))
	}
	if !accepted.narrowed {
		return e.Universe().Clone(), nil
	}
	return accepted.bits, nil
}
