package filters

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/bitset"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

type scalarKey struct {
	kind    model.FilterValueKind
	number  float64
	text    string
	boolean bool
}

func scalarKeyOf(value model.FilterValue) scalarKey {
	key := scalarKey{kind: value.Kind()}
	key.number, _ = value.Number()
	key.text, _ = value.Text()
	key.boolean, _ = value.Boolean()
	if key.number == 0 {
		key.number = 0
	}
	return key
}

func distinctScalars(values []model.FilterValue) []model.FilterValue {
	seen := make(map[scalarKey]struct{}, len(values))
	distinct := make([]model.FilterValue, 0, len(values))
	for _, value := range values {
		key := scalarKeyOf(value)
		if _, held := seen[key]; held {
			continue
		}
		seen[key] = struct{}{}
		distinct = append(distinct, value)
	}
	return distinct
}

func (e *evaluation) matchPatternInto(fieldPath string, value model.FilterValue, into bitset.Bits) error {
	if e.patterns == nil {
		return missingPatternSearch(fieldPath)
	}
	text, _ := value.Text()
	return e.patterns.MatchEqualInto(e, fieldPath, text, into)
}

func (e *evaluation) elementBits(fieldPath string, field schema.ParsedFieldType, value model.FilterValue) (bitset.Bits, error) {
	into := e.none()
	if field.Pattern {
		return into, e.matchPatternInto(fieldPath, value, into)
	}
	switch value.Kind() {
	case model.FilterValueNumber:
		if index := e.source.Numeric(fieldPath); index != nil {
			number, _ := value.Number()
			index.EqualInto(number, into)
		}
	case model.FilterValueBoolean:
		if index := e.source.Boolean(fieldPath); index != nil {
			boolean, _ := value.Boolean()
			index.EqualInto(boolean, into)
		}
	default:
		if index := e.source.Enum(fieldPath); index != nil {
			text, _ := value.Text()
			index.EqualInto(text, into)
		}
	}
	return into, nil
}

func (e *evaluation) anyElementBits(fieldPath string, field schema.ParsedFieldType, values []model.FilterValue) (bitset.Bits, error) {
	union := e.none()
	if field.Pattern {
		for _, value := range values {
			if err := e.matchPatternInto(fieldPath, value, union); err != nil {
				return nil, err
			}
		}
		return union, nil
	}
	if field.Base == schema.BaseEnumList {
		if index := e.source.Enum(fieldPath); index != nil {
			texts := make([]string, 0, len(values))
			for _, value := range values {
				text, _ := value.Text()
				texts = append(texts, text)
			}
			index.AnyInto(texts, union)
		}
		return union, nil
	}
	numbers := e.source.Numeric(fieldPath)
	booleans := e.source.Boolean(fieldPath)
	for _, value := range values {
		if number, isNumber := value.Number(); isNumber && numbers != nil {
			numbers.EqualInto(number, union)
		}
		if boolean, isBoolean := value.Boolean(); isBoolean && booleans != nil {
			booleans.EqualInto(boolean, union)
		}
	}
	return union, nil
}

func (e *evaluation) narrowByElements(test *fieldTest, narrow func(bitset.Bits)) error {
	filter := &test.filter
	if filter.MatchesAny != nil {
		matched, err := e.anyElementBits(test.path, test.field, distinctScalars(filter.MatchesAny))
		if err != nil {
			return err
		}
		narrow(matched)
	}
	if filter.ContainsAll != nil {
		all := e.Present(test.path).Clone()
		for _, value := range distinctScalars(filter.ContainsAll) {
			if all.IsEmpty() {
				break
			}
			matched, err := e.elementBits(test.path, test.field, value)
			if err != nil {
				return err
			}
			all.AndWith(matched)
		}
		narrow(all)
	}
	if size := filter.Size; size != nil {
		e.narrowBySize(test.path, size, narrow)
	}
	return nil
}

func (e *evaluation) narrowBySize(fieldPath string, size *model.SizeFilter, narrow func(bitset.Bits)) {
	sizes := e.source.Sizes(fieldPath)
	bounds := []struct {
		comparison comparison
		bound      model.Optional[float64]
	}{
		{comparisonEqual, size.Eq}, {comparisonNotEqual, size.Ne}, {comparisonAbove, size.Gt},
		{comparisonAtLeast, size.Gte}, {comparisonBelow, size.Lt}, {comparisonAtMost, size.Lte},
	}
	for _, entry := range bounds {
		if value, set := entry.bound.Get(); set {
			narrow(e.comparisonBits(sizes, fieldPath, numberTest{entry.comparison, value}))
		}
	}
	if interval, set := size.Between.Get(); set {
		narrow(e.betweenBits(sizes, interval.Low, interval.High))
	}
}
