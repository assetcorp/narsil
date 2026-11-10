package pattern

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/bitset"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/filters"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

func scopeIndex(scope filters.PatternScope, fieldPath string) (Reader, func(ordinal uint32) any, bool) {
	source := scope.Source()
	indexes, holdsIndexes := source.(IndexSource)
	if !holdsIndexes {
		return nil, nil, false
	}
	index, held := indexes.PatternIndex(fieldPath)
	if !held || index == nil {
		return nil, nil, false
	}
	valueOf := func(ordinal uint32) any {
		document, live := source.Document(ordinal)
		if !live {
			return nil
		}
		value, found := text.ReadSortField(document, fieldPath)
		if !found {
			return nil
		}
		return value
	}
	return index, valueOf, true
}

func (search *Search) matchScope(scope filters.PatternScope, fieldPath string, test Test, into bitset.Bits) error {
	index, valueOf, held := scopeIndex(scope, fieldPath)
	if !held {
		return nil
	}
	return search.MatchInto(index, valueOf, test, into)
}

func (search *Search) MatchEqualInto(scope filters.PatternScope, fieldPath string, value string, into bitset.Bits) error {
	return search.matchScope(scope, fieldPath, Test{Operator: OperatorEq, Text: value}, into)
}

func distinctTexts(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	distinct := make([]string, 0, len(values))
	for _, value := range values {
		if _, held := seen[value]; held {
			continue
		}
		seen[value] = struct{}{}
		distinct = append(distinct, value)
	}
	return distinct
}

func excluding(scope filters.PatternScope, fieldPath string, excluded bitset.Bits) bitset.Bits {
	universe := scope.Present(fieldPath).Clone()
	universe.AndWith(scope.Universe())
	kept := bitset.New(scope.Capacity())
	kept.OrWith(universe)
	kept.AndNotWith(excluded)
	return kept
}

func (search *Search) EvaluateTests(scope filters.PatternScope, fieldPath string, filter *model.FieldFilter, narrow func(matched bitset.Bits)) error {
	caseFold := filter.CaseFold
	matching := func(operator Operator, texts []string, wanted model.PatternTolerance) (bitset.Bits, error) {
		into := bitset.New(scope.Capacity())
		for _, source := range texts {
			test := Test{Operator: operator, Text: source, CaseFold: caseFold, Tolerance: wanted}
			if err := search.matchScope(scope, fieldPath, test, into); err != nil {
				return nil, err
			}
		}
		return into, nil
	}
	var narrowed []bitset.Bits
	keep := func(matched bitset.Bits, err error) error {
		if err == nil {
			narrowed = append(narrowed, matched)
		}
		return err
	}
	noTolerance := model.PatternTolerance{}
	if eq, isText := filter.Eq.Text(); isText {
		if err := keep(matching(OperatorEq, []string{eq}, filter.Tolerance)); err != nil {
			return err
		}
	}
	if ne, isText := filter.Ne.Text(); isText {
		matched, err := matching(OperatorEq, []string{ne}, noTolerance)
		if err != nil {
			return err
		}
		narrowed = append(narrowed, excluding(scope, fieldPath, matched))
	}
	if filter.In != nil {
		if err := keep(matching(OperatorEq, distinctTexts(filter.In), noTolerance)); err != nil {
			return err
		}
	}
	if filter.Nin != nil {
		matched, err := matching(OperatorEq, distinctTexts(filter.Nin), noTolerance)
		if err != nil {
			return err
		}
		narrowed = append(narrowed, excluding(scope, fieldPath, matched))
	}
	affixes := []struct {
		operator Operator
		value    model.Optional[string]
	}{
		{OperatorStartsWith, filter.StartsWith}, {OperatorEndsWith, filter.EndsWith}, {OperatorContains, filter.Contains},
		{OperatorWildcard, filter.Wildcard}, {OperatorRegex, filter.Regex},
	}
	for _, affix := range affixes {
		if source, set := affix.value.Get(); set {
			if err := keep(matching(affix.operator, []string{source}, noTolerance)); err != nil {
				return err
			}
		}
	}
	for _, matched := range narrowed {
		narrow(matched)
	}
	return nil
}
