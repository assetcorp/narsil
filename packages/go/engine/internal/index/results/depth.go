package results

import (
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type PositionPage struct {
	Start     int
	Limit     int
	PinnedIDs model.Optional[map[string]struct{}]
}

type PositionCursor struct {
	Anchor string
	Score  model.Optional[float64]
	Depth  int
}

func FixedHybridDepth(hybrid *model.HybridConfig) (int, bool, error) {
	if hybrid == nil {
		return 0, false, nil
	}
	depth, set := hybrid.Depth.Get()
	if !set {
		return 0, false, nil
	}
	if depth < minHybridDepth || depth > maxHybridDepth {
		return 0, false, narsilerr.New(
			narsilerr.CodeConfigInvalid,
			"hybrid.depth must be a whole number from "+strconv.Itoa(minHybridDepth)+" to "+strconv.Itoa(maxHybridDepth),
			map[string]any{"depth": depth},
		)
	}
	return depth, true, nil
}

func RequireWithinHybridDepth(cursorDepth, offset, depth int) error {
	start := saturatingAdd(cursorDepth, offset)
	if start < depth {
		return nil
	}
	return narsilerr.New(
		narsilerr.CodeSearchResultWindowExceeded,
		"A hybrid query pages through the first "+strconv.Itoa(depth)+" fused results, and this page starts at "+strconv.Itoa(start)+". Raise hybrid.depth to page further",
		map[string]any{"offset": offset, "cursorDepth": cursorDepth, "depth": depth},
	)
}

func lastOrganicIndex(page []Hit, pinnedIDs map[string]struct{}, placesPins bool) int {
	for index := len(page) - 1; index >= 0; index-- {
		if !placesPins {
			return index
		}
		if _, pinned := pinnedIDs[page[index].ID]; !pinned {
			return index
		}
	}
	return -1
}

func organicPositionOf(organic []string, id string) int {
	for index, candidate := range organic {
		if candidate == id {
			return index
		}
	}
	return -1
}

func PageByPosition(placed []Hit, organic []string, window PositionPage) ([]Hit, *PositionCursor) {
	if window.Limit <= 0 {
		return []Hit{}, nil
	}
	end := saturatingAdd(window.Start, window.Limit)
	page := sliceLikeJavaScript(placed, window.Start, end)
	pinnedIDs, placesPins := window.PinnedIDs.Get()
	last := lastOrganicIndex(page, pinnedIDs, placesPins)
	if len(placed) <= end || last < 0 {
		return page, nil
	}
	anchor := page[last]
	depth := saturatingAdd(window.Start, last+1)
	if placesPins {
		depth = organicPositionOf(organic, anchor.ID) + 1
	}
	return page, &PositionCursor{Anchor: anchor.ID, Score: anchor.Score, Depth: depth}
}
