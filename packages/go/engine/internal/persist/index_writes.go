package persist

import (
	"context"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index"
)

func heldDocumentIDs(ctx context.Context, target *index.Index, candidates ...[]string) ([]string, error) {
	held := []string{}
	chosen := map[string]struct{}{}
	for _, ids := range candidates {
		for _, id := range ids {
			if _, seen := chosen[id]; seen {
				continue
			}
			chosen[id] = struct{}{}
			present, err := target.Has(ctx, id)
			if err != nil {
				return nil, err
			}
			if present {
				held = append(held, id)
			}
		}
	}
	return held, nil
}

func removalsOf(ids []string) []index.DocumentWrite {
	writes := make([]index.DocumentWrite, len(ids))
	for at, id := range ids {
		writes[at] = index.DocumentWrite{ID: id}
	}
	return writes
}

func applyInBatches(target *index.Index, kind index.WriteKind, writes []index.DocumentWrite,
	refusal func([]error) error) error {
	for start := 0; start < len(writes); start += RecoveryInsertBatchDocuments {
		end := min(start+RecoveryInsertBatchDocuments, len(writes))
		refused, err := target.Apply(kind, writes[start:end], nil)
		if err != nil {
			return err
		}
		if err := refusal(refused); err != nil {
			return err
		}
	}
	return nil
}

func replaceDocuments(ctx context.Context, target *index.Index, removed []string, inserted []index.DocumentWrite,
	refusal func([]error) error) error {
	insertedIDs := make([]string, len(inserted))
	for at, write := range inserted {
		insertedIDs[at] = write.ID
	}
	replaced, err := heldDocumentIDs(ctx, target, removed, insertedIDs)
	if err != nil {
		return err
	}
	if err := applyInBatches(target, index.WriteRemove, removalsOf(replaced), refusal); err != nil {
		return err
	}
	return applyInBatches(target, index.WriteInsert, inserted, refusal)
}
