package pattern

const saturatedPositions = MaxPositions + 1

type multiFoldKey struct {
	codePoints [3]rune
	count      int
}

func saturating(total int) int {
	return min(total, saturatedPositions)
}

func positionsOf(parsed *node, caseFold bool, scratch []rune) int {
	switch parsed.kind {
	case nodeLiteral:
		if !caseFold {
			return 1
		}
		return len(appendFolded(scratch[:0], parsed.codePoint))
	case nodeAny, nodeClass:
		return 1
	case nodeSet:
		if !caseFold || parsed.negated {
			return 1
		}
		total := 1
		for _, fold := range distinctMultiFolds(parsed.setItems) {
			total = saturating(total + len(fold))
		}
		return total
	case nodeAssert:
		return 0
	case nodeSequence, nodeChoice:
		total := 0
		for _, child := range parsed.children {
			total = saturating(total + positionsOf(child, caseFold, scratch))
			if total == saturatedPositions {
				return total
			}
		}
		return total
	case nodeRepeat:
		copies := parsed.max
		if parsed.max == unboundedRepeat {
			copies = max(parsed.min, 1)
		}
		return saturating(copies * positionsOf(parsed.body, caseFold, scratch))
	case nodeNumberRange:
		return positionsOf(parsed.body, caseFold, scratch)
	}
	return 0
}

func patternPositions(parsed *node, caseFold bool) int {
	return positionsOf(parsed, caseFold, make([]rune, 0, 4))
}

func distinctMultiFolds(items []setItem) [][]rune {
	seen := map[multiFoldKey]struct{}{}
	var folds [][]rune
	for _, item := range items {
		if item.kind != setMember {
			continue
		}
		fold := appendFolded(nil, item.codePoint)
		if len(fold) < 2 {
			continue
		}
		key := multiFoldKey{count: len(fold)}
		copy(key.codePoints[:], fold)
		if _, held := seen[key]; held {
			continue
		}
		seen[key] = struct{}{}
		folds = append(folds, fold)
	}
	return folds
}
