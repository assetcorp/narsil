package results

import (
	"cmp"
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

func DedupePinnedEntries(pinned []model.PinnedDocument) []model.PinnedDocument {
	deduped := make([]model.PinnedDocument, 0, len(pinned))
	seen := make(map[string]struct{}, len(pinned))
	for _, entry := range pinned {
		if _, repeated := seen[entry.DocID]; repeated {
			continue
		}
		seen[entry.DocID] = struct{}{}
		deduped = append(deduped, entry)
	}
	return deduped
}

func PlacePinned(hits []Hit, pinned []model.PinnedDocument, resolve func(id string) (Hit, bool)) ([]Hit, int) {
	deduped := DedupePinnedEntries(pinned)
	pinnedIDs := make(map[string]struct{}, len(deduped))
	for _, entry := range deduped {
		pinnedIDs[entry.DocID] = struct{}{}
	}
	listed := make(map[string]struct{}, len(deduped))
	placed := make([]Hit, 0, len(hits)+len(deduped))
	for _, hit := range hits {
		if _, isPinned := pinnedIDs[hit.ID]; isPinned {
			listed[hit.ID] = struct{}{}
			continue
		}
		placed = append(placed, hit)
	}
	slices.SortStableFunc(deduped, func(left, right model.PinnedDocument) int {
		return cmp.Compare(left.Position, right.Position)
	})
	fromOutside := 0
	for _, entry := range deduped {
		hit, found := resolve(entry.DocID)
		if !found {
			continue
		}
		if _, wasListed := listed[entry.DocID]; !wasListed {
			fromOutside++
		}
		position := max(0, min(entry.Position, len(placed)))
		placed = slices.Insert(placed, position, hit)
	}
	return placed, fromOutside
}
