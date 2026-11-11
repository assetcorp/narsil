package query

import (
	"math"
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

func scoresTie(left, right float64) bool {
	return left == right || math.IsNaN(left) && math.IsNaN(right)
}

func orderTiedHits(hits []Hit, order DocumentOrder) {
	if order == nil {
		return
	}
	for start := 0; start < len(hits); {
		end := start + 1
		for end < len(hits) && scoresTie(hits[start].Score, hits[end].Score) {
			end++
		}
		if end-start > 1 {
			slices.SortFunc(hits[start:end], order)
		}
		start = end
	}
}

func IDRanks(count int, compare func(left, right int) int) []uint32 {
	ordered := make([]int, count)
	for at := range ordered {
		ordered[at] = at
	}
	slices.SortFunc(ordered, compare)
	ranks := make([]uint32, count)
	rank := uint32(0)
	for at, entry := range ordered {
		if at > 0 && compare(ordered[at-1], entry) != 0 {
			rank++
		}
		ranks[entry] = rank
	}
	return ranks
}

type MergedEntry struct {
	List  int
	Index int
}

func mergeLayoutError() error {
	return narsilerr.New(narsilerr.CodeConfigInvalid, "The search rankings or limit exceed the merge layout", nil)
}

func MergeRankings(workspace *core.Workspace, scores [][]float64, ranks []uint32, limit uint64) ([]MergedEntry, error) {
	count := 0
	for _, list := range scores {
		count += len(list)
	}
	if uint64(count) > math.MaxUint32 || uint64(len(scores)) > math.MaxUint32 || limit > math.MaxUint32 || len(ranks) != count {
		return nil, mergeLayoutError()
	}
	offsets := make([]uint32, len(scores)+1)
	flat := make([]float64, 0, count)
	for list, values := range scores {
		offsets[list] = uint32(len(flat))
		flat = append(flat, values...)
	}
	offsets[len(scores)] = uint32(count)
	needed := min(uint64(count), limit)
	output := core.MergeOutput{Lists: make([]uint32, needed), Indices: make([]uint32, needed)}
	found, err := workspace.MergeRankings(&core.RankingMergeRequest{Offsets: offsets, Scores: flat, IDRanks: ranks, Limit: uint32(needed)}, &output)
	if err != nil {
		return nil, narsilerr.Wrap(narsilerr.CodeConfigInvalid, "The search rankings cannot be merged", err, nil)
	}
	return mergedEntries(output, found), nil
}

func MergeSorted(workspace *core.Workspace, sizes []int, ranks []uint32, limit uint64) ([]MergedEntry, error) {
	count := 0
	for _, size := range sizes {
		count += size
	}
	if uint64(count) > math.MaxUint32 || uint64(len(sizes)) > math.MaxUint32 || limit > math.MaxUint32 || len(ranks) != count {
		return nil, mergeLayoutError()
	}
	offsets := make([]uint32, len(sizes)+1)
	total := 0
	for list, size := range sizes {
		offsets[list] = uint32(total)
		total += size
	}
	offsets[len(sizes)] = uint32(count)
	needed := min(uint64(count), limit)
	output := core.MergeOutput{Lists: make([]uint32, needed), Indices: make([]uint32, needed)}
	found, err := workspace.MergeSorted(&core.SortedMergeRequest{Offsets: offsets, Ranks: ranks, Limit: uint32(needed)}, &output)
	if err != nil {
		return nil, narsilerr.Wrap(narsilerr.CodeConfigInvalid, "The search rankings cannot be merged", err, nil)
	}
	return mergedEntries(output, found), nil
}

func mergedEntries(output core.MergeOutput, found uint32) []MergedEntry {
	merged := make([]MergedEntry, found)
	for at := range merged {
		merged[at] = MergedEntry{List: int(output.Lists[at]), Index: int(output.Indices[at])}
	}
	return merged
}

func MergeByScore[Entry any](workspace *core.Workspace, lists [][]Entry, limit uint64, scoreOf func(Entry) float64, order func(left, right Entry) int) ([]Entry, error) {
	var only []Entry
	populated, total := 0, 0
	for _, list := range lists {
		if len(list) > 0 {
			only = list
			populated++
			total += len(list)
		}
	}
	if populated <= 1 {
		return only[:min(uint64(len(only)), limit)], nil
	}
	flat := make([]Entry, 0, total)
	scores := make([][]float64, len(lists))
	for list, entries := range lists {
		scores[list] = make([]float64, len(entries))
		for at, entry := range entries {
			scores[list][at] = scoreOf(entry)
		}
		flat = append(flat, entries...)
	}
	ranks := IDRanks(len(flat), func(left, right int) int {
		if order == nil {
			return 0
		}
		return order(flat[left], flat[right])
	})
	merged, err := MergeRankings(workspace, scores, ranks, limit)
	if err != nil {
		return nil, err
	}
	entries := make([]Entry, len(merged))
	for at, entry := range merged {
		entries[at] = lists[entry.List][entry.Index]
	}
	return entries, nil
}

func MergeHits(workspace *core.Workspace, lists [][]Hit, order DocumentOrder, limit uint64) ([]Hit, error) {
	return MergeByScore(workspace, lists, limit, func(hit Hit) float64 { return hit.Score }, order)
}
