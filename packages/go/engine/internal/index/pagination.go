package index

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/cursor"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/results"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type paginationSort struct {
	signature  string
	directions []text.SortDirection
	sortKeyOf  func(id string) []text.SortValue
}

type pageOfHits struct {
	hits   []results.Hit
	cursor string
}

func ordersAfterAnchor(hit results.Hit, anchor cursor.PageCursor, sort *paginationSort) bool {
	if sort != nil && anchor.SortSignature.IsSet() {
		comparison := text.CompareComparableKeys(sort.sortKeyOf(hit.ID), anchor.SortKey, sort.directions)
		if comparison == 0 {
			comparison = text.CompareCodePoints(hit.ID, anchor.Anchor)
		}
		return comparison > 0
	}
	anchorScore, anchored := anchor.Score.Get()
	if !anchored {
		return true
	}
	score, scored := hit.Score.Get()
	if !scored || score < anchorScore {
		return true
	}
	return score == anchorScore && text.CompareCodePoints(hit.ID, anchor.Anchor) > 0
}

func lastOrganicHit(page []results.Hit, pinnedIDs map[string]struct{}) (results.Hit, bool) {
	for at := len(page) - 1; at >= 0; at-- {
		if _, pinned := pinnedIDs[page[at].ID]; !pinned {
			return page[at], true
		}
	}
	return results.Hit{}, false
}

func applyPagination(hits []results.Hit, limit, offset int, binding func() string, searchAfter string, sort *paginationSort, pinnedIDs map[string]struct{}, omitsDepth bool) (pageOfHits, error) {
	var decoded cursor.PageCursor
	seeking := searchAfter != ""
	if seeking {
		parsed, err := cursor.DecodePageCursor(searchAfter)
		if err != nil {
			return pageOfHits{}, err
		}
		signature := model.Optional[string]{}
		if sort != nil {
			signature = model.Some(sort.signature)
		}
		if err := cursor.RequireMatchingCursor(parsed, searchAfter, signature, true, binding()); err != nil {
			return pageOfHits{}, err
		}
		decoded = parsed
	}
	if limit <= 0 {
		return pageOfHits{hits: []results.Hit{}}, nil
	}
	start := 0
	if seeking {
		start = len(hits)
		for at, hit := range hits {
			if ordersAfterAnchor(hit, decoded, sort) {
				start = at
				break
			}
		}
	}
	afterOffset := start + offset
	from := min(afterOffset, len(hits))
	to := min(afterOffset+limit, len(hits))
	page := append([]results.Hit{}, hits[from:max(from, to)]...)
	hasMore := afterOffset+limit < len(hits)
	last, found := lastOrganicHit(page, pinnedIDs)
	if !hasMore || !found {
		return pageOfHits{hits: page}, nil
	}
	next := cursor.PageCursor{Anchor: last.ID, Depth: afterOffset + len(page), Binding: binding()}
	if omitsDepth {
		next.Depth = 0
	}
	if sort != nil {
		next.SortKey = sort.sortKeyOf(last.ID)
		next.SortSignature = model.Some(sort.signature)
	} else {
		next.Score = last.Score
	}
	return pageOfHits{hits: page, cursor: cursor.EncodePageCursor(next)}, nil
}
