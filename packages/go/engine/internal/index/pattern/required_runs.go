package pattern

import "math"

type runQuery struct {
	anyBranch bool
	runs      []uint32
	branches  [][]uint32
}

type factorCollector struct {
	factors [][]rune
	current []rune
}

func (collector *factorCollector) flush() {
	if len(collector.current) >= RunCodePoints {
		collector.factors = append(collector.factors, collector.current)
	}
	collector.current = nil
}

func (collector *factorCollector) visit(parsed *node) {
	switch parsed.kind {
	case nodeLiteral:
		collector.current = appendFolded(collector.current, parsed.codePoint)
	case nodeAssert:
	case nodeSequence:
		for _, item := range parsed.children {
			collector.visit(item)
		}
	case nodeRepeat:
		if parsed.min == 1 && parsed.max == 1 {
			collector.visit(parsed.body)
			return
		}
		collector.flush()
		if parsed.min >= 1 {
			collector.visit(parsed.body)
			collector.flush()
		}
	default:
		collector.flush()
	}
}

func roundHalfUp(numerator, denominator int) int {
	value := float64(numerator) / float64(denominator)
	whole := math.Floor(value)
	if value-whole >= 0.5 {
		whole++
	}
	return int(whole)
}

func factorRunCount(factor []rune) int {
	return max(0, len(factor)-RunCodePoints+1)
}

func spreadRuns(factors [][]rune) []uint32 {
	total := 0
	for _, factor := range factors {
		total += factorRunCount(factor)
	}
	if total == 0 {
		return nil
	}
	picks := min(total, shortlistRunLookups)
	seen := make(map[runKey]struct{}, picks)
	runs := make([]uint32, 0, picks*RunCodePoints)
	factorAt, factorStart := 0, 0
	for pick := range picks {
		target := 0
		if picks > 1 {
			target = roundHalfUp(pick*(total-1), picks-1)
		}
		factorRuns := factorRunCount(factors[factorAt])
		for target >= factorStart+factorRuns {
			factorStart += factorRuns
			factorAt++
			factorRuns = factorRunCount(factors[factorAt])
		}
		key := runKeyAt(factors[factorAt], target-factorStart)
		if _, held := seen[key]; held {
			continue
		}
		seen[key] = struct{}{}
		runs = append(runs, key[0], key[1], key[2])
	}
	return runs
}

func branchRuns(parsed *node) []uint32 {
	collector := &factorCollector{}
	collector.visit(parsed)
	collector.flush()
	return spreadRuns(collector.factors)
}

func requiredRuns(parsed *node) runQuery {
	if parsed.kind != nodeChoice {
		return runQuery{runs: branchRuns(parsed)}
	}
	branches := make([][]uint32, 0, len(parsed.children))
	for _, branch := range parsed.children {
		runs := branchRuns(branch)
		if len(runs) == 0 {
			return runQuery{}
		}
		branches = append(branches, runs)
	}
	return runQuery{anyBranch: true, branches: branches}
}
