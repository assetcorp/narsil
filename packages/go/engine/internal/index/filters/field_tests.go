package filters

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/bitset"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/fieldindex"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/geo"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

type comparison uint8

const (
	comparisonEqual comparison = iota
	comparisonNotEqual
	comparisonAbove
	comparisonAtLeast
	comparisonBelow
	comparisonAtMost
)

type numberTest struct {
	comparison comparison
	value      float64
}

func (e *evaluation) comparisonBits(index *fieldindex.Numeric, fieldPath string, test numberTest) bitset.Bits {
	into := e.none()
	if test.comparison == comparisonNotEqual {
		if index != nil {
			index.EqualInto(test.value, into)
		}
		return e.without(e.Present(fieldPath), into)
	}
	if index == nil {
		return into
	}
	switch test.comparison {
	case comparisonEqual:
		index.EqualInto(test.value, into)
	case comparisonAbove:
		index.AboveInto(test.value, into)
	case comparisonAtLeast:
		index.AtLeastInto(test.value, into)
	case comparisonBelow:
		index.BelowInto(test.value, into)
	default:
		index.AtMostInto(test.value, into)
	}
	return into
}

func (e *evaluation) betweenBits(index *fieldindex.Numeric, low, high float64) bitset.Bits {
	into := e.none()
	if index != nil {
		index.BetweenInto(low, high, into)
	}
	return into
}

func numberTestsOf(filter *model.FieldFilter) []numberTest {
	var tests []numberTest
	if value, isNumber := filter.Eq.Number(); isNumber {
		tests = append(tests, numberTest{comparisonEqual, value})
	}
	if value, isNumber := filter.Ne.Number(); isNumber {
		tests = append(tests, numberTest{comparisonNotEqual, value})
	}
	bounds := []struct {
		comparison comparison
		bound      model.RangeBound
	}{{comparisonAbove, filter.Gt}, {comparisonAtLeast, filter.Gte}, {comparisonBelow, filter.Lt}, {comparisonAtMost, filter.Lte}}
	for _, entry := range bounds {
		if value, isNumber := entry.bound.Number(); isNumber {
			tests = append(tests, numberTest{entry.comparison, value})
		}
	}
	return tests
}

func (e *evaluation) narrowByFieldTests(test *fieldTest, narrow func(bitset.Bits)) error {
	filter := &test.filter
	e.narrowByPresence(test.path, filter, narrow)
	e.narrowByLocation(test.path, filter, narrow)
	e.narrowByTextRange(test.path, filter, narrow)
	if test.field.Pattern {
		if e.patterns == nil {
			return missingPatternSearch(test.path)
		}
		if err := e.patterns.EvaluateTests(e, test.path, filter, narrow); err != nil {
			return err
		}
	} else {
		e.narrowByValue(test.path, filter, test.field, narrow)
	}
	return e.narrowByElements(test, narrow)
}

func (e *evaluation) narrowByPresence(fieldPath string, filter *model.FieldFilter, narrow func(bitset.Bits)) {
	if exists, set := filter.Exists.Get(); set {
		narrow(e.presentWhen(fieldPath, exists))
	}
	if notExists, set := filter.NotExists.Get(); set {
		narrow(e.presentWhen(fieldPath, !notExists))
	}
	if isNotEmpty, set := filter.IsNotEmpty.Get(); set {
		narrow(e.holdingWhen(fieldPath, isNotEmpty))
	}
	if isEmpty, set := filter.IsEmpty.Get(); set {
		narrow(e.holdingWhen(fieldPath, !isEmpty))
	}
}

func (e *evaluation) presentWhen(fieldPath string, wanted bool) bitset.Bits {
	if wanted {
		return e.Present(fieldPath)
	}
	return e.complement(e.Present(fieldPath))
}

func (e *evaluation) holdingWhen(fieldPath string, wanted bool) bitset.Bits {
	holding := e.holdingSomething(fieldPath)
	if wanted {
		return holding
	}
	return e.complement(holding)
}

func (e *evaluation) narrowByLocation(fieldPath string, filter *model.FieldFilter, narrow func(bitset.Bits)) {
	index := e.source.Geo(fieldPath)
	if circle := filter.Radius; circle != nil {
		found := e.none()
		if metresPerUnit, known := geo.MetresPerUnit(circle.Unit); index != nil && known {
			index.RadiusQuery(circle.Lat, circle.Lon, float64(circle.Distance*metresPerUnit), circle.Inside.Or(true), circle.HighPrecision, found)
		}
		narrow(found)
	}
	if polygon := filter.Polygon; polygon != nil {
		found := e.none()
		if index != nil {
			index.PolygonQuery(polygon.Points, polygon.Inside.Or(true), found)
		}
		narrow(found)
	}
}

func (e *evaluation) narrowByValue(fieldPath string, filter *model.FieldFilter, field schema.ParsedFieldType, narrow func(bitset.Bits)) {
	switch field.Base {
	case schema.BaseNumber, schema.BaseNumberList:
		index := e.source.Numeric(fieldPath)
		for _, test := range numberTestsOf(filter) {
			narrow(e.comparisonBits(index, fieldPath, test))
		}
		low, lowIsNumber := filter.Between.Low.Number()
		high, highIsNumber := filter.Between.High.Number()
		if lowIsNumber && highIsNumber {
			narrow(e.betweenBits(index, low, high))
		}
	case schema.BaseBoolean, schema.BaseBooleanList:
		e.narrowByBooleanValue(fieldPath, filter, narrow)
	case schema.BaseEnum, schema.BaseEnumList:
		e.narrowByEnumValue(fieldPath, filter, narrow)
	}
}

func (e *evaluation) narrowByBooleanValue(fieldPath string, filter *model.FieldFilter, narrow func(bitset.Bits)) {
	index := e.source.Boolean(fieldPath)
	equal := func(value bool) bitset.Bits {
		into := e.none()
		if index != nil {
			index.EqualInto(value, into)
		}
		return into
	}
	if value, isBoolean := filter.Eq.Boolean(); isBoolean {
		narrow(equal(value))
	}
	if value, isBoolean := filter.Ne.Boolean(); isBoolean {
		narrow(e.without(e.Present(fieldPath), equal(value)))
	}
}

func (e *evaluation) narrowByEnumValue(fieldPath string, filter *model.FieldFilter, narrow func(bitset.Bits)) {
	index := e.source.Enum(fieldPath)
	read := func(fill func(index *fieldindex.Enum, into bitset.Bits)) bitset.Bits {
		into := e.none()
		if index != nil {
			fill(index, into)
		}
		return into
	}
	equal := func(value string) bitset.Bits {
		return read(func(index *fieldindex.Enum, into bitset.Bits) { index.EqualInto(value, into) })
	}
	anyOf := func(values []string) bitset.Bits {
		return read(func(index *fieldindex.Enum, into bitset.Bits) { index.AnyInto(values, into) })
	}
	if value, isText := filter.Eq.Text(); isText {
		narrow(equal(value))
	}
	if value, isText := filter.Ne.Text(); isText {
		narrow(e.without(e.Present(fieldPath), equal(value)))
	}
	if filter.In != nil {
		narrow(anyOf(filter.In))
	}
	if filter.Nin != nil {
		narrow(e.without(e.Present(fieldPath), anyOf(filter.Nin)))
	}
	if prefix, set := filter.StartsWith.Get(); set {
		narrow(read(func(index *fieldindex.Enum, into bitset.Bits) { index.PrefixInto(prefix, into) }))
	}
	if suffix, set := filter.EndsWith.Get(); set {
		narrow(read(func(index *fieldindex.Enum, into bitset.Bits) { index.SuffixInto(suffix, into) }))
	}
}
