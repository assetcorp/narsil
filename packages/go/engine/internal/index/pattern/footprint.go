package pattern

import (
	"maps"
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

func positionWords(positions int) int {
	return max(1, (positions+positionsPerWord-1)/positionsPerWord)
}

func SmallestMatcherBytes(positions int) int {
	return 2*positionWords(positions)*uint32Bytes + positions*matcherCodePointBytes +
		positions*matcherSimulationBytes + matcherStateOverhead + positions*uint32Bytes
}

type largestFootprint struct {
	bytes int
	found bool
}

func (largest *largestFootprint) offer(bytes int) {
	if !largest.found || bytes > largest.bytes {
		largest.bytes = bytes
	}
	largest.found = true
}

func literalFootprint(source string, caseFold bool) int {
	if caseFold {
		return SmallestMatcherBytes(foldedCodePointCount(source))
	}
	return SmallestMatcherBytes(text.CodePointCount(source))
}

func (largest *largestFootprint) offerTests(filter *model.FieldFilter) error {
	for _, named := range testTextsOf(filter) {
		for _, source := range named.texts {
			largest.offer(literalFootprint(source, filter.CaseFold))
		}
	}
	expressions := []struct {
		operator Operator
		value    model.Optional[string]
	}{{OperatorWildcard, filter.Wildcard}, {OperatorRegex, filter.Regex}}
	for _, expression := range expressions {
		source, set := expression.value.Get()
		if !set {
			continue
		}
		bytes, err := ExpressionFootprint(expression.operator, source, filter.CaseFold)
		if err != nil {
			return err
		}
		largest.offer(bytes)
	}
	return nil
}

func (largest *largestFootprint) offerExpression(expression *model.FilterExpression, isPatternField func(fieldPath string) bool) error {
	for _, fieldPath := range slices.Sorted(maps.Keys(expression.Fields)) {
		if !isPatternField(fieldPath) {
			continue
		}
		filter := expression.Fields[fieldPath]
		if err := largest.offerTests(&filter); err != nil {
			return err
		}
	}
	nested := make([]*model.FilterExpression, 0, len(expression.And)+len(expression.Or)+1)
	for at := range expression.And {
		nested = append(nested, &expression.And[at])
	}
	for at := range expression.Or {
		nested = append(nested, &expression.Or[at])
	}
	if expression.Not != nil {
		nested = append(nested, expression.Not)
	}
	for _, child := range nested {
		if err := largest.offerExpression(child, isPatternField); err != nil {
			return err
		}
	}
	return nil
}

func LargestFootprint(expression *model.FilterExpression, isPatternField func(fieldPath string) bool) (int, bool, error) {
	if expression == nil {
		return 0, false, nil
	}
	largest := &largestFootprint{}
	if err := largest.offerExpression(expression, isPatternField); err != nil {
		return 0, false, err
	}
	return largest.bytes, largest.found, nil
}
