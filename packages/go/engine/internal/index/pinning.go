package index

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/query"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

func pinsOf(pinned []model.PinnedDocument) []query.Pin {
	pins := make([]query.Pin, len(pinned))
	for at, entry := range pinned {
		pins[at] = query.Pin{ID: entry.DocID, Position: entry.Position}
	}
	return query.DedupePinned(pins)
}

func storedPinsOf(pinned []model.PinnedDocument, has func(id string) bool) []query.Pin {
	deduped := pinsOf(pinned)
	kept := deduped[:0]
	for _, pin := range deduped {
		if has(pin.ID) {
			kept = append(kept, pin)
		}
	}
	return kept
}

func pinnedIDsOf(pins []query.Pin) map[string]struct{} {
	ids := make(map[string]struct{}, len(pins))
	for _, pin := range pins {
		ids[pin.ID] = struct{}{}
	}
	return ids
}

func placePinned(hits []resultHit, pins []query.Pin) ([]resultHit, int, error) {
	if len(pins) == 0 {
		return hits, 0, nil
	}
	ids := make([]string, len(hits))
	for at, hit := range hits {
		ids[at] = hit.ID
	}
	order, ranked, err := query.PinnedOrder(ids, pins, model.Optional[int]{})
	if err != nil {
		return nil, 0, err
	}
	placed := make([]resultHit, len(order))
	for at, entry := range order {
		if entry >= 0 {
			placed[at] = hits[entry]
			continue
		}
		placed[at] = resultHit{ID: pins[-1-entry].ID, Score: model.Some(0.0)}
	}
	fromOutside := 0
	for _, position := range ranked {
		if position < 0 {
			fromOutside++
		}
	}
	return placed, fromOutside, nil
}
