package index

import (
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type positionPage struct {
	start     int
	limit     int
	pinnedIDs model.Optional[map[string]struct{}]
}

type positionCursor struct {
	anchor string
	score  model.Optional[float64]
	depth  int
}

func fixedHybridDepth(hybrid *model.HybridConfig) (int, bool, error) {
	if hybrid == nil {
		return 0, false, nil
	}
	depth, set := hybrid.Depth.Get()
	if !set {
		return 0, false, nil
	}
	if depth < minHybridDepth || depth > maxHybridDepth {
		return 0, false, narsilerr.New(narsilerr.CodeConfigInvalid,
			"hybrid.depth must be a whole number from "+strconv.Itoa(minHybridDepth)+" to "+strconv.Itoa(maxHybridDepth),
			map[string]any{"depth": depth})
	}
	return depth, true, nil
}

func requireWithinHybridDepth(cursorDepth, offset, depth int) error {
	start := saturatingAdd(cursorDepth, offset)
	if start < depth {
		return nil
	}
	return narsilerr.New(narsilerr.CodeSearchResultWindowExceeded,
		"A hybrid query pages through the first "+strconv.Itoa(depth)+" fused results, and this page starts at "+strconv.Itoa(start)+". Raise hybrid.depth to page further",
		map[string]any{"offset": offset, "cursorDepth": cursorDepth, "depth": depth})
}

func relativeIndex(index, length int) int {
	if index < 0 {
		return max(length+index, 0)
	}
	return min(index, length)
}

func sliceLikeJavaScript(hits []resultHit, start, end int) []resultHit {
	from := relativeIndex(start, len(hits))
	to := relativeIndex(end, len(hits))
	if to <= from {
		return []resultHit{}
	}
	return append([]resultHit(nil), hits[from:to]...)
}

func lastOrganicIndex(page []resultHit, pinnedIDs map[string]struct{}, placesPins bool) int {
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

func pageByPosition(placed []resultHit, organic []string, window positionPage) ([]resultHit, *positionCursor) {
	if window.limit <= 0 {
		return []resultHit{}, nil
	}
	end := saturatingAdd(window.start, window.limit)
	page := sliceLikeJavaScript(placed, window.start, end)
	pinnedIDs, placesPins := window.pinnedIDs.Get()
	last := lastOrganicIndex(page, pinnedIDs, placesPins)
	if len(placed) <= end || last < 0 {
		return page, nil
	}
	anchor := page[last]
	depth := saturatingAdd(window.start, last+1)
	if placesPins {
		depth = organicPositionOf(organic, anchor.ID) + 1
	}
	return page, &positionCursor{anchor: anchor.ID, score: anchor.Score, depth: depth}
}
