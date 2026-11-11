package query

import (
	"strings"
	"unicode/utf16"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

type filterField struct {
	path string
	size bool
}

type filterBuilder struct {
	run      *FilterRun
	segment  *Segment
	types    map[string]schema.ParsedFieldType
	capacity uint32
	live     []uint32
	plan     []uint32
	numbers  []float64
	strings  []string
	lists    []uint32
	bitsets  [][]uint32
	fields   []core.FilterField
	kinds    []core.FilterKind
	ids      map[filterField]int
	present  map[string][]uint32
}

func (b *filterBuilder) emit(opcode core.FilterOpcode, field int, operator core.FilterOperator, operand uint32) {
	b.plan = append(b.plan, uint32(opcode), uint32(field), uint32(operator), operand)
}

func (b *filterBuilder) bitset(words []uint32) {
	b.emit(core.FilterBitset, 0, 0, uint32(len(b.bitsets)))
	b.bitsets = append(b.bitsets, words)
}

func (b *filterBuilder) presentBits(path string) []uint32 {
	if held, found := b.present[path]; found {
		return held
	}
	present := b.segment.Fields.Present[path]
	if present == nil || len(present) < bitsetWords(b.capacity) {
		base := b.types[path].Base
		var index core.FieldIndex
		switch {
		case base == schema.BaseNumber:
			index = b.segment.Fields.Numeric[path]
		case base == schema.BaseBoolean:
			index = b.segment.Fields.Boolean[path]
		case base == schema.BaseEnum:
			index = b.segment.Fields.Enum[path]
		case base == schema.BaseGeopoint:
			index = b.segment.Fields.Geo[path]
		case keepsValueSize(base):
			index = b.segment.Fields.Size[path]
		}
		present = presentOf(index, b.capacity)
	}
	b.present[path] = present
	return present
}

func keepsValueSize(base schema.BaseFieldType) bool {
	return base == schema.BaseString || base == schema.BaseVerbatim || strings.HasSuffix(string(base), "[]")
}

func (b *filterBuilder) field(path string, size bool) int {
	key := filterField{path: path, size: size}
	if held, found := b.ids[key]; found {
		return held
	}
	entry := core.FilterField{Present: b.presentBits(path)}
	kind := core.FilterKindAbsent
	indexes := &b.segment.Fields
	numeric := indexes.Numeric[path]
	if size {
		numeric = indexes.Size[path]
	}
	switch {
	case numeric != nil:
		kind, entry.Index = core.FilterKindNumeric, numeric
	case !size && indexes.Boolean[path] != nil:
		kind, entry.Index = core.FilterKindBoolean, indexes.Boolean[path]
	case !size && indexes.Enum[path] != nil:
		kind, entry.Index = core.FilterKindEnum, indexes.Enum[path]
	case !size && indexes.Geo[path] != nil:
		kind, entry.Index = core.FilterKindGeo, indexes.Geo[path]
	default:
		kind, entry.Index = emptyIndexOf(b.types[path].Base, size)
	}
	b.ids[key] = len(b.fields)
	b.fields = append(b.fields, entry)
	b.kinds = append(b.kinds, kind)
	return len(b.fields) - 1
}

func emptyIndexOf(base schema.BaseFieldType, size bool) (core.FilterKind, core.FieldIndex) {
	switch {
	case size || base == schema.BaseNumber || base == schema.BaseNumberList:
		return core.FilterKindNumeric, &core.NumericIndex{}
	case base == schema.BaseBoolean || base == schema.BaseBooleanList:
		return core.FilterKindBoolean, &core.BooleanIndex{TrueBits: make([]uint32, 1), FalseBits: make([]uint32, 1)}
	case base == schema.BaseEnum || base == schema.BaseEnumList:
		return core.FilterKindEnum, &core.EnumIndex{Offsets: make([]uint32, 1), PostingOffsets: make([]uint32, 1)}
	case base == schema.BaseGeopoint:
		return core.FilterKindGeo, &core.GeoIndex{}
	}
	return core.FilterKindAbsent, nil
}

func (b *filterBuilder) testNumbers(field int, operator core.FilterOperator, values ...float64) {
	b.emit(core.FilterTest, field, operator, uint32(len(b.numbers)))
	b.numbers = append(b.numbers, values...)
}

func (b *filterBuilder) testText(field int, operator core.FilterOperator, text string) {
	b.emit(core.FilterTest, field, operator, uint32(len(b.strings)))
	b.strings = append(b.strings, text)
}

func (b *filterBuilder) testTexts(field int, operator core.FilterOperator, texts []string) {
	b.emit(core.FilterTest, field, operator, uint32(len(b.lists)/2))
	b.lists = append(b.lists, uint32(len(b.strings)), uint32(len(texts)))
	b.strings = append(b.strings, texts...)
}

func (b *filterBuilder) program() (*core.FilterProgram, error) {
	offsets := make([]uint32, len(b.strings)+1)
	var units []uint16
	for at, text := range b.strings {
		units = append(units, utf16.Encode([]rune(text))...)
		if uint64(len(units)) > uint64(^uint32(0)) {
			return nil, narsilerr.New(narsilerr.CodeSearchInvalidFilter, "The texts of a filter exceed the filter layout", nil)
		}
		offsets[at+1] = uint32(len(units))
	}
	return &core.FilterProgram{
		Plan: b.plan, Numbers: b.numbers, Units: units, Offsets: offsets, StringLists: b.lists,
		Bitsets: b.bitsets, Fields: b.fields, Live: b.live,
	}, nil
}
