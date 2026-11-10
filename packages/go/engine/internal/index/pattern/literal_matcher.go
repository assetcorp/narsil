package pattern

type valueMatcher interface {
	begin() bool
	feed(codePoint rune, tally *workTally) bool
	matched() bool
}

type literalMatcher struct {
	codePoints    []rune
	borders       []uint32
	reachable     []uint32
	anchoredStart bool
	anchoredEnd   bool
	prefix        int
	alive         bool
	accepting     bool
	decided       int8
}

func bordersOf(codePoints []rune) []uint32 {
	borders := make([]uint32, len(codePoints)+1)
	border := uint32(0)
	for at := 1; at < len(codePoints); at++ {
		for border > 0 && codePoints[at] != codePoints[border] {
			border = borders[border]
		}
		if codePoints[at] == codePoints[border] {
			border++
		}
		borders[at+1] = border
	}
	return borders
}

func reachablePositionsOf(borders []uint32, length int) []uint32 {
	reachable := make([]uint32, length+1)
	for prefix := 1; prefix <= length; prefix++ {
		unfinished := uint32(0)
		if prefix < length {
			unfinished = 1
		}
		reachable[prefix] = unfinished + reachable[borders[prefix]]
	}
	return reachable
}

func newLiteralMatcher(codePoints []rune, anchoredStart, anchoredEnd bool) *literalMatcher {
	borders := bordersOf(codePoints)
	return &literalMatcher{
		codePoints:    codePoints,
		borders:       borders,
		reachable:     reachablePositionsOf(borders, len(codePoints)),
		anchoredStart: anchoredStart,
		anchoredEnd:   anchoredEnd,
	}
}

func (matcher *literalMatcher) begin() bool {
	matcher.decided = endMatchUnknown
	matcher.prefix = 0
	matcher.alive = len(matcher.codePoints) > 0
	matcher.accepting = len(matcher.codePoints) == 0
	if !matcher.anchoredEnd && matcher.accepting {
		return matcher.decide(true)
	}
	return true
}

func (matcher *literalMatcher) feed(codePoint rune, tally *workTally) bool {
	steps := matcher.steps()
	if steps == 0 {
		return matcher.decide(!matcher.anchoredStart && len(matcher.codePoints) == 0)
	}
	tally.add(int64(steps))
	if matcher.anchoredStart {
		matcher.advanceAnchored(codePoint)
	} else {
		matcher.advance(codePoint)
	}
	if !matcher.anchoredEnd && matcher.accepting {
		return matcher.decide(true)
	}
	return true
}

func (matcher *literalMatcher) matched() bool {
	if matcher.decided != endMatchUnknown {
		return matcher.decided == endMatchTrue
	}
	return matcher.anchoredEnd && matcher.accepting
}

func (matcher *literalMatcher) steps() int {
	length := len(matcher.codePoints)
	if length == 0 {
		return 0
	}
	if matcher.anchoredStart {
		if matcher.alive && matcher.prefix < length {
			return 1
		}
		return 0
	}
	return 1 + int(matcher.reachable[matcher.prefix])
}

func (matcher *literalMatcher) advanceAnchored(codePoint rune) {
	if matcher.codePoints[matcher.prefix] == codePoint {
		matcher.prefix++
		matcher.accepting = matcher.prefix == len(matcher.codePoints)
		return
	}
	matcher.alive = false
	matcher.accepting = false
}

func (matcher *literalMatcher) advance(codePoint rune) {
	codePoints, borders := matcher.codePoints, matcher.borders
	prefix := matcher.prefix
	if prefix == len(codePoints) {
		prefix = int(borders[prefix])
	}
	for prefix > 0 && codePoints[prefix] != codePoint {
		prefix = int(borders[prefix])
	}
	if codePoints[prefix] == codePoint {
		prefix++
	}
	matcher.prefix = prefix
	matcher.accepting = prefix == len(codePoints)
}

func (matcher *literalMatcher) decide(outcome bool) bool {
	matcher.decided = endMatchFalse
	if outcome {
		matcher.decided = endMatchTrue
	}
	return false
}

type workTally struct {
	meter    Meter
	pending  int64
	headroom int64
	err      error
}

func newWorkTally(meter Meter) *workTally {
	return &workTally{meter: meter, headroom: meter.Remaining()}
}

func (tally *workTally) add(units int64) {
	if tally.err != nil {
		return
	}
	tally.pending += units
	if tally.pending >= WorkFlushUnits || tally.pending > tally.headroom {
		tally.flush()
	}
}

func (tally *workTally) flush() {
	if tally.err != nil || tally.pending == 0 {
		return
	}
	units := tally.pending
	tally.pending = 0
	tally.err = tally.meter.Add(units)
	tally.headroom = tally.meter.Remaining()
}
