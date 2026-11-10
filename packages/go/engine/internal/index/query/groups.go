package query

import (
	"math"
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

const (
	DefaultMaxPerGroup = 1
	storedKindUnits    = 4
	storedKindBytes    = 5
)

type StoredRef struct {
	Values  *core.StoredValueSlices
	Ordinal uint32
}

type GroupedHit struct {
	ID     string
	Score  float64
	Fields []StoredRef
}

type HitGroup struct {
	Head  int
	Hits  []int
	Every []int
}

func HitsKeptPerGroup(maxPerGroup model.Optional[int]) int {
	if value, set := maxPerGroup.Get(); set && value >= 1 {
		return value
	}
	return DefaultMaxPerGroup
}

func groupFailure(message string, err error) error {
	if err == nil {
		return narsilerr.New(narsilerr.CodeConfigInvalid, message, nil)
	}
	return narsilerr.Wrap(narsilerr.CodeConfigInvalid, message, err, nil)
}

func refHeld(ref StoredRef) bool {
	return ref.Values != nil && uint64(ref.Ordinal)+1 < uint64(len(ref.Values.Starts)) && int(ref.Ordinal) < len(ref.Values.Shapes)
}

func gatherField(hits []GroupedHit, field int) (core.StoredValueSlices, error) {
	gathered := core.StoredValueSlices{Shapes: make([]uint8, len(hits)), Starts: make([]uint32, len(hits)+1)}
	for row, hit := range hits {
		gathered.Starts[row] = uint32(len(gathered.Kinds))
		if field >= len(hit.Fields) {
			return core.StoredValueSlices{}, groupFailure("A grouped hit needs one stored value reference for every group field", nil)
		}
		ref := hit.Fields[field]
		if !refHeld(ref) {
			return core.StoredValueSlices{}, groupFailure("A grouped hit names a stored value outside its regions", nil)
		}
		values := ref.Values
		start, end := values.Starts[ref.Ordinal], values.Starts[ref.Ordinal+1]
		if start > end || int(end) > len(values.Kinds) || int(end) > len(values.Numbers) || int(end) > len(values.TextStart) || int(end) > len(values.TextLength) {
			return core.StoredValueSlices{}, groupFailure("A grouped hit names a stored value outside its regions", nil)
		}
		gathered.Shapes[row] = values.Shapes[ref.Ordinal]
		for at := start; at < end; at++ {
			kind := values.Kinds[at]
			textStart, textLength := uint64(values.TextStart[at]), uint64(values.TextLength[at])
			position := uint32(0)
			switch kind {
			case storedKindUnits:
				if textStart+textLength > uint64(len(values.Units)) {
					return core.StoredValueSlices{}, groupFailure("A grouped hit names a stored value outside its regions", nil)
				}
				position = uint32(len(gathered.Units))
				gathered.Units = append(gathered.Units, values.Units[textStart:textStart+textLength]...)
			case storedKindBytes:
				if textStart+textLength > uint64(len(values.Bytes)) {
					return core.StoredValueSlices{}, groupFailure("A grouped hit names a stored value outside its regions", nil)
				}
				position = uint32(len(gathered.Bytes))
				gathered.Bytes = append(gathered.Bytes, values.Bytes[textStart:textStart+textLength]...)
			}
			gathered.Kinds = append(gathered.Kinds, kind)
			gathered.Numbers = append(gathered.Numbers, values.Numbers[at])
			gathered.TextStart = append(gathered.TextStart, position)
			gathered.TextLength = append(gathered.TextLength, uint32(textLength))
		}
	}
	gathered.Starts[len(hits)] = uint32(len(gathered.Kinds))
	return gathered, nil
}

func idRanksOf(ids []string) []uint32 {
	order := make([]int, len(ids))
	for at := range order {
		order[at] = at
	}
	slices.SortStableFunc(order, func(left, right int) int { return text.CompareCodePoints(ids[left], ids[right]) })
	ranks := make([]uint32, len(ids))
	rank := uint32(0)
	for at := range order {
		if at > 0 && ids[order[at-1]] != ids[order[at]] {
			rank++
		}
		ranks[order[at]] = rank
	}
	return ranks
}

func groupHitsWith(workspace *core.Workspace, fields []core.StoredValueSlices, ordinals []uint32, scores []float64, idRanks []uint32, perGroup uint32, limit int) ([]HitGroup, error) {
	count := len(ordinals)
	request := &core.GroupRequest{
		Values: make([]core.StoredValues, len(fields)), Ordinals: ordinals, Scores: scores, IDRanks: idRanks,
		MaxPerGroup: perGroup, HasLimit: limit >= 0, Limit: uint32(max(0, limit)),
	}
	for at := range fields {
		request.Values[at] = *fields[at].Values()
	}
	output := &core.GroupOutput{
		Heads: make([]uint32, count), Offsets: make([]uint32, count+1), Hits: make([]uint32, count), Members: make([]uint32, count),
	}
	found, err := workspace.GroupHits(request, output)
	if err != nil {
		return nil, groupFailure("The hits cannot be grouped", err)
	}
	groups := make([]HitGroup, found)
	for at := range groups {
		groups[at].Head = int(output.Heads[at])
		for member := output.Offsets[at]; member < output.Offsets[at+1]; member++ {
			groups[at].Every = append(groups[at].Every, int(output.Hits[member]))
		}
	}
	return groups, nil
}

func GroupHits(hits []GroupedHit, config model.GroupConfig) ([]HitGroup, error) {
	if len(config.Fields) == 0 {
		every := make([]int, len(hits))
		for at := range every {
			every[at] = at
		}
		return []HitGroup{{Head: -1, Hits: every, Every: every}}, nil
	}
	if uint64(len(hits)) > math.MaxUint32 {
		return nil, groupFailure("The hit count exceeds the group layout", nil)
	}
	fields := make([]core.StoredValueSlices, len(config.Fields))
	for field := range fields {
		gathered, err := gatherField(hits, field)
		if err != nil {
			return nil, err
		}
		fields[field] = gathered
	}
	ordinals := make([]uint32, len(hits))
	scores := make([]float64, len(hits))
	ids := make([]string, len(hits))
	for at, hit := range hits {
		ordinals[at], scores[at], ids[at] = uint32(at), hit.Score, hit.ID
	}
	kept := HitsKeptPerGroup(config.MaxPerGroup)
	limit := -1
	if value, set := config.Limit.Get(); set && value >= 0 {
		limit = min(value, len(hits))
	}
	perGroup := uint32(len(hits))
	if config.Reduce == nil {
		perGroup = uint32(min(kept, len(hits)))
	} else {
		limit = -1
	}
	workspace, err := core.AcquireWorkspace()
	if err != nil {
		return nil, err
	}
	defer workspace.Release()
	groups, err := groupHitsWith(workspace, fields, ordinals, scores, idRanksOf(ids), perGroup, limit)
	if err != nil {
		return nil, err
	}
	for at := range groups {
		groups[at].Hits = groups[at].Every[:min(kept, len(groups[at].Every))]
	}
	if value, set := config.Limit.Get(); set && value >= 0 && len(groups) > value {
		groups = groups[:value]
	}
	return groups, nil
}
