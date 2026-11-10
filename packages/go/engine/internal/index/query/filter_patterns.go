package query

import (
	"fmt"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

func sortTextUnits(text string) []uint16 {
	if utf8.RuneCountInString(text) > SortValueMaxCodePoints {
		runes := []rune(text)
		return utf16.Encode(runes[:SortValueMaxCodePoints])
	}
	return utf16.Encode([]rune(text))
}

func (b *filterBuilder) textRangeBits(path string, lower, upper *string, lowerInclusive, upperInclusive bool) ([]uint32, error) {
	column := b.segment.Fields.Sort[SortColumnKey{Field: path, Mode: core.SortMin}]
	if column == nil {
		return nil, narsilerr.New(narsilerr.CodeConfigInvalid, "A text range filter needs the minimum sort column of its field, which the partition view does not hold", map[string]any{"field": path})
	}
	request := &core.TextRangeRequest{Live: b.live, Output: newBits(b.capacity)}
	if lower != nil {
		request.Lower = core.TextBound{Present: true, Units: sortTextUnits(*lower), Inclusive: lowerInclusive}
	}
	if upper != nil {
		request.Upper = core.TextBound{Present: true, Units: sortTextUnits(*upper), Inclusive: upperInclusive}
	}
	if err := core.TextRange(column, request); err != nil {
		return nil, narsilerr.Wrap(narsilerr.CodeConfigInvalid, "The text range could not be selected", err, nil)
	}
	return request.Output, nil
}

func patternTolerance(tolerance model.PatternTolerance) uint32 {
	if tolerance.Kind() == model.PatternToleranceAuto {
		return core.PatternAutoTolerance
	}
	if edits, set := tolerance.Edits(); set && edits >= 0 && edits <= core.PatternMaxTolerance {
		return uint32(edits)
	}
	return 0
}

func (b *filterBuilder) matchPattern(path string, operator core.PatternOperator, text string, caseFold bool, tolerance uint32, into []uint32) error {
	index := b.segment.Fields.Pattern[path]
	if index == nil {
		return nil
	}
	values := b.segment.Fields.Stored[path]
	if values == nil {
		return narsilerr.New(narsilerr.CodePartitionCorrupted, "A pattern field of the partition view holds no stored values", map[string]any{"field": path})
	}
	test := &core.PatternTest{
		Text: utf16.Encode([]rune(text)), Operator: operator, CaseFold: caseFold, Tolerance: tolerance,
		MatcherBytes: MatcherStateBudgetBytes,
	}
	if operator == core.PatternEq && tolerance != 0 {
		key := fmt.Sprint(caseFold, "|", tolerance, "|", text)
		if !b.run.claimed[key] {
			b.run.claimed[key] = true
			test.CountPreparation = true
		}
	}
	err := b.run.workspace.PatternMatch(index, core.StoredValuesOf(*values), test, b.run.meter, into)
	if spent := b.run.meter.Spent(); spent > b.run.meter.Cap() {
		return narsilerr.New(narsilerr.CodeSearchWorkCapExceeded, "The work on the pattern tests and phrases of this search passed its cap", map[string]any{"cap": float64(b.run.meter.Cap())})
	}
	if b.run.meter.Stopped() {
		return ErrStopped
	}
	if err != nil {
		return refusal(err)
	}
	return nil
}

func (b *filterBuilder) matching(path string, operator core.PatternOperator, texts []string, caseFold bool, tolerance uint32) ([]uint32, error) {
	into := newBits(b.capacity)
	for _, text := range texts {
		if err := b.matchPattern(path, operator, text, caseFold, tolerance, into); err != nil {
			return nil, err
		}
	}
	return into, nil
}

func (b *filterBuilder) excluding(path string, excluded []uint32) []uint32 {
	universe := andBits(b.presentBits(path), b.live)
	return andBits(universe, notBits(excluded, b.capacity))
}

func distinctTexts(texts []string) []string {
	seen := map[string]bool{}
	var kept []string
	for _, text := range texts {
		if !seen[text] {
			seen[text] = true
			kept = append(kept, text)
		}
	}
	return kept
}

func (b *filterBuilder) patternTests(path string, filter *model.FieldFilter, appended func()) error {
	caseFold := filter.CaseFold
	push := func(words []uint32, err error) error {
		if err != nil {
			return err
		}
		b.bitset(words)
		appended()
		return nil
	}
	if text, isText := filter.Eq.Text(); isText {
		if err := push(b.matching(path, core.PatternEq, []string{text}, caseFold, patternTolerance(filter.Tolerance))); err != nil {
			return err
		}
	}
	if text, isText := filter.Ne.Text(); isText {
		excluded, err := b.matching(path, core.PatternEq, []string{text}, caseFold, 0)
		if err != nil {
			return err
		}
		_ = push(b.excluding(path, excluded), nil)
	}
	if filter.In != nil {
		if err := push(b.matching(path, core.PatternEq, distinctTexts(filter.In), caseFold, 0)); err != nil {
			return err
		}
	}
	if filter.Nin != nil {
		excluded, err := b.matching(path, core.PatternEq, distinctTexts(filter.Nin), caseFold, 0)
		if err != nil {
			return err
		}
		_ = push(b.excluding(path, excluded), nil)
	}
	for _, entry := range []struct {
		text     model.Optional[string]
		operator core.PatternOperator
	}{
		{filter.StartsWith, core.PatternStartsWith}, {filter.EndsWith, core.PatternEndsWith},
		{filter.Contains, core.PatternContains}, {filter.Wildcard, core.PatternWildcard}, {filter.Regex, core.PatternRegex},
	} {
		if text, set := entry.text.Get(); set {
			if err := push(b.matching(path, entry.operator, []string{text}, caseFold, 0)); err != nil {
				return err
			}
		}
	}
	return nil
}

func (b *filterBuilder) patternElements(path string, values []model.FilterValue, every bool) ([]uint32, error) {
	var words []uint32
	if every {
		words = append([]uint32(nil), b.presentBits(path)...)
	} else {
		words = newBits(b.capacity)
	}
	for _, value := range values {
		text, isText := value.Text()
		if !isText {
			continue
		}
		if every && countBits(words) == 0 {
			break
		}
		into := words
		if every {
			into = newBits(b.capacity)
		}
		if err := b.matchPattern(path, core.PatternEq, text, false, 0, into); err != nil {
			return nil, err
		}
		if every {
			words = andBits(words, into)
		}
	}
	return words, nil
}
