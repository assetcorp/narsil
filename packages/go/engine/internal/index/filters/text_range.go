package filters

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/bitset"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type textBound struct {
	value     text.SortValue
	inclusive bool
}

type textRange struct {
	lower *textBound
	upper *textBound
}

func boundOf(value string, inclusive bool) *textBound {
	return &textBound{value: text.StringSortValue(text.TruncateSortString(value)), inclusive: inclusive}
}

func (bounds textRange) holds(value text.SortValue) bool {
	if value.IsMissing() {
		return false
	}
	if bounds.lower != nil {
		comparison := text.CompareComparableValues(value, bounds.lower.value, text.SortAscending)
		if comparison < 0 || (comparison == 0 && !bounds.lower.inclusive) {
			return false
		}
	}
	if bounds.upper != nil {
		comparison := text.CompareComparableValues(value, bounds.upper.value, text.SortAscending)
		if comparison > 0 || (comparison == 0 && !bounds.upper.inclusive) {
			return false
		}
	}
	return true
}

func (e *evaluation) textRangeBits(fieldPath string, bounds textRange) bitset.Bits {
	result := e.none()
	e.Universe().ForEach(func(ordinal uint32) bool {
		document, found := e.source.Document(ordinal)
		if !found {
			return true
		}
		raw, _ := text.ReadSortField(document, fieldPath)
		if bounds.holds(text.ToReducedSortValue(raw, text.SortModeMin)) {
			result.Set(ordinal)
		}
		return true
	})
	return result
}

func (e *evaluation) narrowByTextRange(fieldPath string, filter *model.FieldFilter, narrow func(bitset.Bits)) {
	ranges := []struct {
		bound  model.RangeBound
		bounds func(string) textRange
	}{
		{filter.Gt, func(value string) textRange { return textRange{lower: boundOf(value, false)} }},
		{filter.Gte, func(value string) textRange { return textRange{lower: boundOf(value, true)} }},
		{filter.Lt, func(value string) textRange { return textRange{upper: boundOf(value, false)} }},
		{filter.Lte, func(value string) textRange { return textRange{upper: boundOf(value, true)} }},
	}
	for _, entry := range ranges {
		if value, isText := entry.bound.Text(); isText {
			narrow(e.textRangeBits(fieldPath, entry.bounds(value)))
		}
	}
	low, lowIsText := filter.Between.Low.Text()
	high, highIsText := filter.Between.High.Text()
	if lowIsText && highIsText {
		narrow(e.textRangeBits(fieldPath, textRange{lower: boundOf(low, true), upper: boundOf(high, true)}))
	}
}
