package pattern

import (
	"math"

	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type multiFoldKey struct {
	codePoints [3]rune
	count      int
}

func appendFolded(destination []rune, codePoint rune) []rune {
	return text.AppendFoldedCodePoint(destination, codePoint)
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

type typoText struct {
	folded      []rune
	longestFold int
}

func foldTypoText(source string) typoText {
	prepared := typoText{folded: make([]rune, 0, len(source))}
	for _, codePoint := range source {
		before := len(prepared.folded)
		prepared.folded = appendFolded(prepared.folded, codePoint)
		prepared.longestFold = max(prepared.longestFold, len(prepared.folded)-before)
	}
	return prepared
}

type runKey [RunCodePoints]rune

func roundHalfUp(numerator, denominator int) int {
	value := float64(numerator) / float64(denominator)
	whole := math.Floor(value)
	if value-whole >= 0.5 {
		whole++
	}
	return int(whole)
}

func typoRunsNeeded(tolerance, longestFold int) int {
	return tolerance*(2+longestFold) + 1
}

func distinctTypoRunCount(prepared typoText, limit int) int {
	folded := prepared.folded
	positions := len(folded) - RunCodePoints + 1
	kept := map[runKey]struct{}{}
	keep := func(at int) {
		kept[runKey{folded[at], folded[at+1], folded[at+2]}] = struct{}{}
	}
	if positions > limit && limit > 1 {
		for pick := range limit {
			keep(roundHalfUp(pick*(positions-1), limit-1))
		}
	}
	for at := 0; at < positions && len(kept) < limit; at++ {
		keep(at)
	}
	return len(kept)
}
