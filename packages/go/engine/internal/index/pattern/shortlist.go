package pattern

import "slices"

func intersect(candidates, list []uint32, tally *workTally) []uint32 {
	kept := make([]uint32, 0, min(len(candidates), len(list)))
	read := 0
	for _, candidate := range candidates {
		for read < len(list) && list[read] < candidate {
			read++
		}
		if read == len(list) {
			break
		}
		if list[read] == candidate {
			kept = append(kept, candidate)
		}
	}
	tally.add(int64(min(len(list), read+1)))
	return kept
}

func shortlistAll(index Reader, runs []uint32, tally *workTally) []uint32 {
	lists := make([][]uint32, 0, len(runs)/RunCodePoints)
	for at := 0; at+RunCodePoints <= len(runs); at += RunCodePoints {
		tally.add(1)
		lists = append(lists, index.Postings(runs[at], runs[at+1], runs[at+2]))
	}
	slices.SortStableFunc(lists, func(left, right []uint32) int { return len(left) - len(right) })
	candidates := lists[0]
	tally.add(int64(len(candidates)))
	for at := 1; at < len(lists) && len(candidates) > 0 && tally.err == nil; at++ {
		if len(lists[at]) > len(candidates)*shortlistIntersectRatio {
			break
		}
		candidates = intersect(candidates, lists[at], tally)
	}
	return candidates
}

func union(left, right []uint32) []uint32 {
	if len(left) == 0 {
		return right
	}
	if len(right) == 0 {
		return left
	}
	merged := make([]uint32, 0, len(left)+len(right))
	fromLeft, fromRight := 0, 0
	for fromLeft < len(left) && fromRight < len(right) {
		smaller := min(left[fromLeft], right[fromRight])
		if left[fromLeft] == smaller {
			fromLeft++
		}
		if right[fromRight] == smaller {
			fromRight++
		}
		merged = append(merged, smaller)
	}
	merged = append(merged, left[fromLeft:]...)
	return append(merged, right[fromRight:]...)
}

func shortlist(index Reader, query runQuery, tally *workTally) ([]uint32, bool) {
	if !query.anyBranch {
		if len(query.runs) == 0 {
			return nil, false
		}
		return shortlistAll(index, query.runs, tally), true
	}
	var candidates []uint32
	for _, runs := range query.branches {
		candidates = union(candidates, shortlistAll(index, runs, tally))
		if tally.err != nil {
			break
		}
	}
	return candidates, true
}
