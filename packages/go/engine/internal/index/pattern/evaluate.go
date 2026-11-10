package pattern

import "github.com/assetcorp/narsil/packages/go/engine/internal/index/bitset"

type matchRequest struct {
	search    *Search
	operator  Operator
	text      string
	caseFold  bool
	tolerance tolerance
	index     Reader
	into      bitset.Bits
	valueOf   func(ordinal uint32) any
}

type preparedTest struct {
	runs    runQuery
	entry   *cachedExpression
	literal []rune
}

func (request *matchRequest) prepare() (*preparedTest, error) {
	if request.operator.isExpression() {
		entry, err := request.search.expression(request.operator, request.text, request.caseFold)
		if err != nil {
			return nil, err
		}
		return &preparedTest{runs: entry.prepared.runs, entry: entry}, nil
	}
	return &preparedTest{runs: request.search.literalRunsOf(request.text)}, nil
}

func (request *matchRequest) answeredByTypoTest(tally *workTally) bool {
	if request.operator != OperatorEq || (!request.tolerance.auto && request.tolerance.edits == 0) {
		return false
	}
	test := request.search.typoTestFor(request.text, request.caseFold, request.tolerance, tally)
	if test == nil || tally.err != nil {
		return tally.err != nil
	}
	matchWithinTolerance(request, test, tally)
	return true
}

func matchesText(matcher valueMatcher, value string, caseFold bool, folded []rune, tally *workTally) ([]rune, bool) {
	if !matcher.begin() {
		return folded, matcher.matched()
	}
	for at := 0; at < len(value); {
		if tally.err != nil {
			return folded, false
		}
		codePoint, size := nextCodePoint(value, at)
		at += size
		if !caseFold {
			if !matcher.feed(codePoint, tally) {
				return folded, matcher.matched()
			}
			continue
		}
		folded = appendFolded(folded[:0], codePoint)
		for _, foldedCodePoint := range folded {
			if !matcher.feed(foldedCodePoint, tally) {
				return folded, matcher.matched()
			}
		}
	}
	return folded, matcher.matched()
}

func (request *matchRequest) match() error {
	tally := newWorkTally(request.search.meter)
	if request.answeredByTypoTest(tally) {
		tally.flush()
		return tally.err
	}
	test, err := request.prepare()
	if err != nil {
		return err
	}
	candidates, shortlisted := shortlist(request.index, test.runs, tally)
	if tally.err != nil {
		return tally.err
	}
	if !shortlisted {
		candidates = request.index.Documents()
	}
	var matcher valueMatcher
	var lease *leasedMatcher
	defer func() {
		if lease != nil {
			request.search.returnMatcher(lease)
		}
	}()
	into := request.into
	folded := make([]rune, 0, 4)
	for _, ordinal := range candidates {
		if tally.err != nil {
			return tally.err
		}
		if int(ordinal>>5) >= len(into) || into.Has(ordinal) {
			continue
		}
		if !shortlisted {
			tally.add(1)
		}
		if matcher == nil {
			matcher, lease = request.matcherFor(test)
		}
		matched := false
		forEachTextValue(request.valueOf(ordinal), func(value string) bool {
			folded, matched = matchesText(matcher, value, request.caseFold, folded, tally)
			return !matched && tally.err == nil
		})
		if matched && tally.err == nil {
			into.Set(ordinal)
		}
	}
	tally.flush()
	return tally.err
}

func (request *matchRequest) matcherFor(test *preparedTest) (valueMatcher, *leasedMatcher) {
	if test.entry != nil {
		lease := request.search.leaseMatcher(test.entry)
		return lease.dfa, lease
	}
	codePoints := appendTextCodePoints(nil, request.text, request.caseFold)
	anchoredStart := request.operator == OperatorEq || request.operator == OperatorStartsWith
	anchoredEnd := request.operator == OperatorEq || request.operator == OperatorEndsWith
	return newLiteralMatcher(codePoints, anchoredStart, anchoredEnd), nil
}
