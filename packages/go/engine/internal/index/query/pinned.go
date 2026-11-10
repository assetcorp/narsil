package query

import (
	"math"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

const pinPositionHalfBits = 32

type Pin struct {
	ID       string
	Position int
}

type PageEntry struct {
	ID       string
	Score    float64
	HasScore bool
	SortKey  []any
}

type PageAnchor struct {
	ID         string
	SortKey    []any
	HasSortKey bool
	Score      float64
	HasScore   bool
}

func DedupePinned(pins []Pin) []Pin {
	seen := map[string]bool{}
	kept := make([]Pin, 0, len(pins))
	for _, pin := range pins {
		if !seen[pin.ID] {
			seen[pin.ID] = true
			kept = append(kept, pin)
		}
	}
	return kept
}

func pinsByPosition(workspace *core.Workspace, pins []Pin) ([]int, error) {
	source := make([]int, len(pins))
	for at := range source {
		source[at] = at
	}
	tied := make([]float64, len(pins))
	scores := make([][]float64, len(pins))
	for at := range scores {
		scores[at] = tied[at : at+1]
	}
	ranks := make([]uint32, len(pins))
	for _, shift := range []uint{0, pinPositionHalfBits} {
		for at, pin := range source {
			ranks[at] = uint32(uint64(pins[pin].Position) >> shift)
		}
		merged, err := MergeRankings(workspace, scores, ranks, uint64(len(pins)))
		if err != nil {
			return nil, err
		}
		ordered := make([]int, len(merged))
		for at, entry := range merged {
			ordered[at] = source[entry.List]
		}
		source = ordered
	}
	return source, nil
}

func PinnedOrder(ids []string, pins []Pin, depth model.Optional[int]) ([]int32, []int32, error) {
	if len(ids) > math.MaxInt32 || len(pins) > math.MaxInt32 {
		return nil, nil, narsilerr.New(narsilerr.CodeConfigInvalid, "The ranked result and pin lists must each fit signed 32-bit positions", nil)
	}
	byID := make(map[string]int32, len(ids))
	for at, id := range ids {
		byID[id] = int32(at)
	}
	limit, hasDepth := depth.Get()
	request := &core.PinnedRequest{Count: uint32(len(ids)), Ranked: make([]int32, len(pins)), Positions: make([]uint32, len(pins))}
	removed, placed, wide := 0, 0, false
	for at, pin := range pins {
		if pin.Position < 0 {
			return nil, nil, narsilerr.New(narsilerr.CodeConfigInvalid, "A pinned document position must be a non-negative integer",
				map[string]any{"docId": pin.ID, "position": float64(pin.Position)})
		}
		request.Ranked[at] = core.PinnedAbsentFromRanking
		if position, found := byID[pin.ID]; found {
			request.Ranked[at] = position
			removed++
		}
		request.Positions[at] = uint32(min(uint64(pin.Position), math.MaxUint32))
		if !hasDepth || pin.Position < limit {
			placed++
		}
		wide = wide || uint64(pin.Position) > math.MaxUint32
	}
	if hasDepth {
		if limit < 0 || uint64(limit) > math.MaxUint32 {
			return nil, nil, narsilerr.New(narsilerr.CodeConfigInvalid, "The pinned depth must fit an unsigned 32-bit integer", nil)
		}
		request.HasDepth, request.Depth = true, uint32(limit)
	}
	workspace, err := core.AcquireWorkspace()
	if err != nil {
		return nil, nil, err
	}
	defer workspace.Release()
	ranked := request.Ranked
	var source []int
	if wide {
		if source, err = pinsByPosition(workspace, pins); err != nil {
			return nil, nil, err
		}
		request.Ranked, request.Positions = make([]int32, len(pins)), make([]uint32, len(pins))
		for at, pin := range source {
			request.Ranked[at] = ranked[pin]
			request.Positions[at] = uint32(min(uint64(pins[pin].Position), math.MaxUint32))
		}
	}
	order := make([]int32, len(ids)-removed+placed)
	count, err := workspace.PlacePinned(request, order)
	if err != nil {
		return nil, nil, narsilerr.Wrap(narsilerr.CodeConfigInvalid, "The pinned documents cannot be placed", err, nil)
	}
	order = order[:count]
	if source != nil {
		for at, entry := range order {
			if entry < 0 {
				order[at] = int32(-1 - source[-1-entry])
			}
		}
	}
	return order, ranked, nil
}

func PageStart(entries []PageEntry, anchor PageAnchor, directions []text.SortDirection) (int, error) {
	if uint64(len(entries)) > math.MaxUint32 {
		return 0, narsilerr.New(narsilerr.CodeConfigInvalid, "The result page cannot be selected", nil)
	}
	words := bitsetWords(uint32(len(entries)))
	sorted := directions != nil && anchor.HasSortKey
	request := &core.PageRequest{
		Count: uint32(len(entries)), Sorted: sorted, AfterAnchor: make([]uint32, words),
		HasAnchorScore: anchor.HasScore, AnchorScore: anchor.Score,
	}
	if !sorted {
		request.HasScores, request.Scores = true, make([]float64, len(entries))
	}
	for position, entry := range entries {
		comparison := 0
		if sorted {
			comparison = text.CompareSortValues(entry.SortKey, anchor.SortKey, directions)
		}
		if comparison == 0 {
			comparison = text.CompareCodePoints(entry.ID, anchor.ID)
		}
		if comparison > 0 {
			setBit(request.AfterAnchor, uint32(position))
		}
		if sorted {
			continue
		}
		if !entry.HasScore {
			if !request.HasScorePresent {
				request.HasScorePresent, request.ScorePresent = true, make([]uint32, words)
				for word := range request.ScorePresent {
					request.ScorePresent[word] = math.MaxUint32
				}
			}
			request.ScorePresent[position>>5] &^= 1 << (position & 31)
		} else {
			request.Scores[position] = entry.Score
		}
	}
	start, err := core.PageStart(request)
	if err != nil {
		return 0, narsilerr.Wrap(narsilerr.CodeConfigInvalid, "The result page cannot be selected", err, nil)
	}
	return int(start), nil
}
