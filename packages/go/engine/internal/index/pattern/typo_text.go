package pattern

type typoText struct {
	codePoints  int
	folded      []rune
	longestFold int
}

func foldTypoText(source string, tally *workTally) typoText {
	prepared := typoText{folded: make([]rune, 0, len(source))}
	for at := 0; at < len(source); {
		if tally != nil {
			tally.add(1)
		}
		codePoint, size := nextCodePoint(source, at)
		at += size
		before := len(prepared.folded)
		prepared.folded = appendFolded(prepared.folded, codePoint)
		prepared.codePoints++
		prepared.longestFold = max(prepared.longestFold, len(prepared.folded)-before)
	}
	return prepared
}

func holdsRun(runs []uint32, key runKey) bool {
	for at := 0; at+RunCodePoints <= len(runs); at += RunCodePoints {
		if runs[at] == key[0] && runs[at+1] == key[1] && runs[at+2] == key[2] {
			return true
		}
	}
	return false
}

func keepDistinctRun(runs []uint32, folded []rune, at int, tally *workTally) []uint32 {
	if tally != nil {
		tally.add(1)
	}
	key := runKeyAt(folded, at)
	if holdsRun(runs, key) {
		return runs
	}
	return append(runs, key[0], key[1], key[2])
}

func distinctTypoRuns(prepared typoText, limit int, tally *workTally) []uint32 {
	folded := prepared.folded
	positions := len(folded) - RunCodePoints + 1
	wanted := limit * RunCodePoints
	var runs []uint32
	if positions > limit && limit > 1 {
		for pick := range limit {
			runs = keepDistinctRun(runs, folded, roundHalfUp(pick*(positions-1), limit-1), tally)
		}
	}
	for at := 0; at < positions && len(runs) < wanted; at++ {
		runs = keepDistinctRun(runs, folded, at, tally)
	}
	return runs
}

func typoRunsNeeded(tolerance, longestFold int) int {
	return tolerance*(2+longestFold) + 1
}

func typoRunLimit(longestFold int) int {
	return max(typoRunsNeeded(MaxTolerance, longestFold), shortlistRunLookups)
}

func distinctTypoRunCount(prepared typoText, limit int) int {
	return len(distinctTypoRuns(prepared, limit, nil)) / RunCodePoints
}

type tolerance struct {
	auto  bool
	edits int
}

func resolvedTypoTolerance(wanted tolerance, longestFold, distinctRuns int) int {
	if !wanted.auto {
		return wanted.edits
	}
	for candidate := MaxTolerance; candidate > 0; candidate-- {
		if distinctRuns >= typoRunsNeeded(candidate, longestFold) {
			return candidate
		}
	}
	return 0
}
