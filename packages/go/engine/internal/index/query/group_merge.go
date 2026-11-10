package query

import (
	"math"
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/fields"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type GroupEntry struct {
	ID         string
	Score      float64
	HasScore   bool
	SortValues []any
}

type GroupSource struct {
	Values  map[string]any
	Entries []GroupEntry
}

type MergedGroup struct {
	Values  map[string]any
	Entries []GroupEntry
}

func groupIdentities(workspace *core.Workspace, sources []GroupSource, paths []string) ([]uint32, []map[string]any, error) {
	count := len(sources)
	stored := make([]core.StoredValueSlices, len(paths))
	for at, path := range paths {
		column, err := fields.NewStored(path, fields.DefaultLimits())
		if err != nil {
			return nil, nil, err
		}
		defer column.Release()
		err = column.Backfill(uint32(count), func(ordinal uint32) (any, bool) {
			value, found := sources[ordinal].Values[path]
			return value, found
		})
		if err != nil {
			return nil, nil, err
		}
		stored[at] = column.Slices()
	}
	ordinals := make([]uint32, count)
	for at := range ordinals {
		ordinals[at] = uint32(at)
	}
	groups, err := groupHitsWith(workspace, stored, ordinals, make([]float64, count), ordinals, uint32(count), -1)
	if err != nil {
		return nil, nil, groupFailure("The group values cannot be compared", err)
	}
	keys := make([]uint32, count)
	values := make([]map[string]any, len(groups))
	for group, members := range groups {
		values[group] = sources[members.Head].Values
		for _, position := range members.Every {
			keys[position] = uint32(group)
		}
	}
	return keys, values, nil
}

func entryRanks(entries []GroupEntry, compare func(left, right GroupEntry) int) []uint32 {
	order := make([]int, len(entries))
	for at := range order {
		order[at] = at
	}
	slices.SortStableFunc(order, func(left, right int) int { return compare(entries[left], entries[right]) })
	ranks := make([]uint32, len(entries))
	rank := uint32(0)
	for at := range order {
		if at > 0 && compare(entries[order[at-1]], entries[order[at]]) != 0 {
			rank++
		}
		ranks[order[at]] = rank
	}
	return ranks
}

func MergeGroups(sources []GroupSource, paths []string, maxPerGroup uint32, limit model.Optional[int], directions []text.SortDirection) ([]MergedGroup, error) {
	count := 0
	for _, source := range sources {
		count += len(source.Entries)
	}
	if uint64(count) > math.MaxUint32 || uint64(len(sources)) > math.MaxUint32 {
		return nil, groupFailure("The grouped results exceed the merge layout", nil)
	}
	workspace, err := core.AcquireWorkspace()
	if err != nil {
		return nil, err
	}
	defer workspace.Release()
	keys, values, err := groupIdentities(workspace, sources, paths)
	if err != nil {
		return nil, err
	}
	request := &core.GroupMergeRequest{Keys: keys, Offsets: make([]uint32, len(sources)+1), MaxPerGroup: maxPerGroup, Sorted: directions != nil}
	entries := make([]GroupEntry, 0, count)
	scores := make([]float64, count)
	var presence []uint32
	present := 0
	for source := range sources {
		request.Offsets[source] = uint32(len(entries))
		for _, entry := range sources[source].Entries {
			position := len(entries)
			if !entry.HasScore {
				if presence == nil {
					presence = make([]uint32, bitsetWords(uint32(count)))
					for word := range presence {
						presence[word] = math.MaxUint32
					}
				}
				presence[position>>5] &^= 1 << (position & 31)
			} else {
				scores[position] = entry.Score
				present++
			}
			entries = append(entries, entry)
		}
	}
	request.Offsets[len(sources)] = uint32(len(entries))
	if present > 0 {
		request.HasScores, request.Scores = true, scores
		if presence != nil {
			request.HasScorePresent, request.ScorePresent = true, presence
		}
	}
	byID := func(left, right GroupEntry) int { return text.CompareCodePoints(left.ID, right.ID) }
	request.IDRanks = entryRanks(entries, byID)
	request.Ranks = request.IDRanks
	if directions != nil {
		request.Ranks = entryRanks(entries, func(left, right GroupEntry) int {
			if order := text.CompareSortValues(left.SortValues, right.SortValues, directions); order != 0 {
				return order
			}
			return byID(left, right)
		})
	}
	if value, set := limit.Get(); set {
		if value < 0 || uint64(value) > math.MaxUint32 {
			return nil, groupFailure("The group limit must fit an unsigned 32-bit integer", nil)
		}
		request.HasLimit, request.Limit = true, uint32(value)
	}
	output := &core.GroupMergeOutput{
		Keys: make([]uint32, len(values)), Offsets: make([]uint32, len(values)+1),
		Sources: make([]uint32, count), Indices: make([]uint32, count),
	}
	found, err := workspace.MergeGroups(request, output)
	if err != nil {
		return nil, groupFailure("The groups cannot be merged", err)
	}
	merged := make([]MergedGroup, found)
	for group := range merged {
		merged[group].Values = values[output.Keys[group]]
		for at := output.Offsets[group]; at < output.Offsets[group+1]; at++ {
			merged[group].Entries = append(merged[group].Entries, sources[output.Sources[at]].Entries[output.Indices[at]])
		}
	}
	return merged, nil
}
