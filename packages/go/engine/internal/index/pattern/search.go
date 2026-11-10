package pattern

import (
	"sync"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/bitset"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

type Meter interface {
	Add(units int64) error
	Remaining() int64
}

type IndexSource interface {
	PatternIndex(fieldPath string) (Reader, bool)
}

type Test struct {
	Operator  Operator
	Text      string
	CaseFold  bool
	Tolerance model.PatternTolerance
}

type expressionKey struct {
	operator Operator
	caseFold bool
	text     string
}

type cachedExpression struct {
	key      expressionKey
	prepared *preparedExpression
	program  *program
}

type leasedMatcher struct {
	key        expressionKey
	dfa        *lazyDfa
	limitBytes int
}

type typoKey struct {
	caseFold  bool
	tolerance tolerance
	text      string
}

type Search struct {
	meter            Meter
	budgetBytes      int
	mutex            sync.Mutex
	expressions      map[expressionKey]*cachedExpression
	keptProgramBytes int
	idle             *leasedMatcher
	leasedBytes      int
	literalRuns      map[string]runQuery
	typoTests        map[typoKey]*typoTest
}

func NewSearch(meter Meter) *Search {
	return NewSearchWithBudget(meter, MatcherStateBudgetBytes)
}

func NewSearchWithBudget(meter Meter, budgetBytes int) *Search {
	return &Search{
		meter:       meter,
		budgetBytes: budgetBytes,
		expressions: map[expressionKey]*cachedExpression{},
		literalRuns: map[string]runQuery{},
		typoTests:   map[typoKey]*typoTest{},
	}
}

func (search *Search) expression(operator Operator, source string, caseFold bool) (*cachedExpression, error) {
	key := expressionKey{operator: operator, caseFold: caseFold, text: source}
	search.mutex.Lock()
	defer search.mutex.Unlock()
	if entry, held := search.expressions[key]; held {
		return entry, nil
	}
	prepared, err := prepareExpression(operator, source, caseFold)
	if err != nil {
		return nil, err
	}
	entry := &cachedExpression{key: key, prepared: prepared}
	search.expressions[key] = entry
	return entry, nil
}

func (search *Search) leaseMatcher(entry *cachedExpression) *leasedMatcher {
	search.mutex.Lock()
	defer search.mutex.Unlock()
	if idle := search.idle; idle != nil && idle.key == entry.key {
		search.idle = nil
		return idle
	}
	compiled := entry.program
	if compiled == nil {
		compiled = compileProgram(entry.prepared.plan)
		if (search.keptProgramBytes+compiled.bytes)*keptProgramBudgetHalves <= search.budgetBytes {
			entry.program = compiled
			search.keptProgramBytes += compiled.bytes
		}
	}
	othersBytes := search.keptProgramBytes
	if entry.program != nil {
		othersBytes -= compiled.bytes
	}
	if search.idle != nil {
		search.leasedBytes -= search.idle.limitBytes
		search.idle = nil
	}
	limit := max(0, search.budgetBytes-othersBytes-search.leasedBytes)
	search.leasedBytes += limit
	return &leasedMatcher{key: entry.key, dfa: newLazyDfa(compiled, limit), limitBytes: limit}
}

func (search *Search) returnMatcher(lease *leasedMatcher) {
	search.mutex.Lock()
	defer search.mutex.Unlock()
	if search.idle != nil {
		search.leasedBytes -= search.idle.limitBytes
	}
	search.idle = lease
}

func (search *Search) literalRunsOf(source string) runQuery {
	search.mutex.Lock()
	defer search.mutex.Unlock()
	if runs, held := search.literalRuns[source]; held {
		return runs
	}
	runs := runQuery{runs: spreadRuns([][]rune{appendTextCodePoints(nil, source, true)})}
	search.literalRuns[source] = runs
	return runs
}

func (search *Search) typoTestFor(source string, caseFold bool, wanted tolerance, tally *workTally) *typoTest {
	key := typoKey{caseFold: caseFold, tolerance: wanted, text: source}
	search.mutex.Lock()
	defer search.mutex.Unlock()
	if test, held := search.typoTests[key]; held {
		return test
	}
	test := prepareTypoTest(source, caseFold, wanted, tally)
	search.typoTests[key] = test
	return test
}

func toleranceOf(wanted model.PatternTolerance) tolerance {
	switch wanted.Kind() {
	case model.PatternToleranceAuto:
		return tolerance{auto: true}
	case model.PatternToleranceEdits:
		if edits, _ := wanted.Edits(); edits >= 0 && edits <= MaxTolerance {
			return tolerance{edits: edits}
		}
	}
	return tolerance{}
}

func (search *Search) MatchInto(index Reader, valueOf func(ordinal uint32) any, test Test, into bitset.Bits) error {
	if index == nil {
		return nil
	}
	request := &matchRequest{
		search:    search,
		operator:  test.Operator,
		text:      test.Text,
		caseFold:  test.CaseFold,
		tolerance: toleranceOf(test.Tolerance),
		index:     index,
		into:      into,
		valueOf:   valueOf,
	}
	return request.match()
}
