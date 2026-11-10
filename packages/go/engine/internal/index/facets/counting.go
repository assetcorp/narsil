package facets

import (
	"math"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/bitset"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

const (
	booleanTrueKey  = "true"
	booleanFalseKey = "false"
)

type fieldShape struct {
	declared bool
	base     schema.BaseFieldType
}

func (shape fieldShape) countsRanges() bool {
	return !shape.declared || shape.base == schema.BaseNumber || shape.base == schema.BaseNumberList
}

func (shape fieldShape) readsRangeLists() bool {
	return !shape.declared || shape.base == schema.BaseNumberList
}

func shapeOf(parsed *schema.Parsed, fieldPath string) fieldShape {
	field, declared := parsed.Field(fieldPath)
	return fieldShape{declared: declared, base: field.Base}
}

func countValuesFromDocuments(source DocumentSource, fieldPath string, matched bitset.Bits) map[string]int {
	counts := map[string]int{}
	forEachMatchedValue(source, fieldPath, matched, func(value any) {
		if value == nil {
			return
		}
		if list, isList := value.([]any); isList {
			for _, item := range list {
				counts[javaScriptString(item)]++
			}
			return
		}
		counts[javaScriptString(value)]++
	})
	return counts
}

func withinRange(value float64, bounds model.FacetRange) bool {
	return value >= bounds.From && value < bounds.To
}

func countRangeFromDocuments(source DocumentSource, fieldPath string, shape fieldShape, bounds model.FacetRange, matched bitset.Bits) int {
	count := 0
	forEachMatchedValue(source, fieldPath, matched, func(value any) {
		if list, isList := value.([]any); isList && shape.readsRangeLists() {
			for _, item := range list {
				if withinRange(javaScriptNumber(item), bounds) {
					count++
					return
				}
			}
			return
		}
		if number, isNumber := value.(float64); isNumber && withinRange(number, bounds) {
			count++
		}
	})
	return count
}

func rangeLabel(bounds model.FacetRange) string {
	return text.FormatNumber(bounds.From) + "-" + text.FormatNumber(bounds.To)
}

func countNumericRanges(source Source, fieldPath string, shape fieldShape, ranges []model.FacetRange, matched bitset.Bits) map[string]int {
	counts := make(map[string]int, len(ranges))
	index := source.NumericIndex(fieldPath)
	for _, bounds := range ranges {
		label := rangeLabel(bounds)
		switch {
		case index == nil:
			counts[label] = countRangeFromDocuments(source, fieldPath, shape, bounds, matched)
		case math.IsNaN(bounds.From) || math.IsNaN(bounds.To):
			counts[label] = 0
		default:
			counts[label] = index.RangeCount(bounds.From, bounds.To, matched)
		}
	}
	return counts
}

func countIndexedValues(source Source, fieldPath string, shape fieldShape, matched bitset.Bits) (map[string]int, bool) {
	switch shape.base {
	case schema.BaseEnum, schema.BaseEnumList:
		index := source.EnumIndex(fieldPath)
		if index == nil {
			return nil, false
		}
		enumCounts := index.Counts(matched)
		counts := make(map[string]int, len(enumCounts))
		for _, entry := range enumCounts {
			counts[entry.Value] = entry.Count
		}
		return counts, true
	case schema.BaseBoolean, schema.BaseBooleanList:
		index := source.BooleanIndex(fieldPath)
		if index == nil {
			return nil, false
		}
		trueCount, falseCount := index.Counts(matched)
		counts := make(map[string]int, 2)
		if trueCount > 0 {
			counts[booleanTrueKey] = trueCount
		}
		if falseCount > 0 {
			counts[booleanFalseKey] = falseCount
		}
		return counts, true
	case schema.BaseNumber, schema.BaseNumberList:
		index := source.NumericIndex(fieldPath)
		if index == nil {
			return nil, false
		}
		numberCounts := index.ValueCounts(matched)
		counts := make(map[string]int, len(numberCounts))
		for _, entry := range numberCounts {
			counts[text.FormatNumber(entry.Value)] = entry.Count
		}
		return counts, true
	}
	return nil, false
}

func countFieldValues(source Source, fieldPath string, shape fieldShape, matched bitset.Bits) map[string]int {
	if shape.declared {
		if counts, indexed := countIndexedValues(source, fieldPath, shape, matched); indexed {
			return counts
		}
	}
	return countValuesFromDocuments(source, fieldPath, matched)
}
