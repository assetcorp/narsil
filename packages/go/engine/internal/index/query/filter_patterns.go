package query

import (
	"fmt"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	narsiltext "github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

func patternWorkCapExceeded(workCap int64) error {
	return narsilerr.New(narsilerr.CodeSearchWorkCapExceeded,
		"The engine stopped this search before it checked every candidate, because the work on its pattern tests and phrases passed the cap of "+
			narsiltext.FormatNumber(float64(workCap))+" units. Narrow the tests or the phrases, or raise the patternWorkCap engine setting",
		map[string]any{"cap": float64(workCap)})
}

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
	meter, err := b.run.work.Meter()
	if err != nil {
		return err
	}
	err = b.run.workspace.PatternMatch(index, values.Values(), test, meter, into)
	if spent := meter.Spent(); spent > meter.Cap() {
		return patternWorkCapExceeded(meter.Cap())
	}
	if meter.Stopped() {
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

func (p *fieldPlan) patternTest(operator core.PatternOperator, texts []string, caseFold bool, tolerance uint32, negated bool) error {
	words, err := p.b.matching(p.path, operator, texts, caseFold, tolerance)
	if err != nil {
		return err
	}
	if negated {
		p.b.emit(core.FilterPresent, p.field, 0, 0)
	}
	p.b.bitset(words)
	if negated {
		p.b.emit(core.FilterAndNot, 0, 0, 0)
	}
	p.append()
	return nil
}

func (b *filterBuilder) intersection(universe, left, right []uint32) ([]uint32, error) {
	program := &core.FilterProgram{
		Plan: []uint32{
			uint32(core.FilterBitset), 0, 0, 0,
			uint32(core.FilterBitset), 0, 0, 1,
			uint32(core.FilterAnd), 0, 0, 2,
		},
		Offsets: make([]uint32, 1),
		Bitsets: [][]uint32{left, right},
		Live:    universe,
	}
	into := newBits(b.capacity)
	if err := b.run.workspace.EvaluateFilter(program, into); err != nil {
		return nil, narsilerr.Wrap(narsilerr.CodeConfigInvalid, "The filter plan cannot be evaluated", err, nil)
	}
	return into, nil
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

func (p *fieldPlan) patternTests(filter *model.FieldFilter) error {
	caseFold := filter.CaseFold
	if text, isText := filter.Eq.Text(); isText {
		if err := p.patternTest(core.PatternEq, []string{text}, caseFold, patternTolerance(filter.Tolerance), false); err != nil {
			return err
		}
	}
	if text, isText := filter.Ne.Text(); isText {
		if err := p.patternTest(core.PatternEq, []string{text}, caseFold, 0, true); err != nil {
			return err
		}
	}
	if filter.In != nil {
		if err := p.patternTest(core.PatternEq, distinctTexts(filter.In), caseFold, 0, false); err != nil {
			return err
		}
	}
	if filter.Nin != nil {
		if err := p.patternTest(core.PatternEq, distinctTexts(filter.Nin), caseFold, 0, true); err != nil {
			return err
		}
	}
	for _, entry := range []struct {
		text     model.Optional[string]
		operator core.PatternOperator
	}{
		{filter.StartsWith, core.PatternStartsWith}, {filter.EndsWith, core.PatternEndsWith},
		{filter.Contains, core.PatternContains}, {filter.Wildcard, core.PatternWildcard}, {filter.Regex, core.PatternRegex},
	} {
		if text, set := entry.text.Get(); set {
			if err := p.patternTest(entry.operator, []string{text}, caseFold, 0, false); err != nil {
				return err
			}
		}
	}
	return nil
}

func (b *filterBuilder) patternElements(path string, values []model.FilterValue, every bool) ([]uint32, error) {
	present := b.presentBits(path)[:bitsetWords(b.capacity)]
	words := newBits(b.capacity)
	if every {
		words = present
	}
	for _, value := range values {
		text, isText := value.Text()
		if !isText {
			continue
		}
		if every && bitsetEmpty(words) {
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
			var err error
			if words, err = b.intersection(present, words, into); err != nil {
				return nil, err
			}
		}
	}
	return words, nil
}
