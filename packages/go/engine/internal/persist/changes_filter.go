package persist

import (
	"context"
	"strconv"
	"strings"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/wal"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type FilterMatch struct {
	Before bool
	After  bool
}

func beforeWriteID(at int) string {
	return "before-" + strconv.Itoa(at)
}

func afterWriteID(at int) string {
	return "after-" + strconv.Itoa(at)
}

func (durable *Durable) LoggedDocument(logged []byte) (*model.Document, error) {
	document, err := codec.DecodeStoredDocument(logged, codec.DecodeOptions{ErrorCode: narsilerr.CodePersistenceWalCorrupt})
	if err != nil {
		return nil, err
	}
	for path := range durable.handle.vectorPaths() {
		segments := strings.Split(path, ".")
		holder := nestedHolder(document, segments, false)
		if holder == nil {
			continue
		}
		leaf := segments[len(segments)-1]
		held, present := codec.HeldValue(holder, leaf)
		if !present {
			continue
		}
		if values, isVector := vectorOf(held); isVector {
			holder.Set(leaf, values)
		}
	}
	return document, nil
}

func (durable *Durable) MatchFilter(ctx context.Context, filter *model.FilterExpression, entries []wal.Entry) (
	[]FilterMatch, error) {
	handle := durable.handle
	durable.layoutMutex.RLock()
	detached, err := detachedIndexOf(&Handle{Name: handle.Name, NewDetachedIndex: handle.NewDetachedIndex})
	durable.layoutMutex.RUnlock()
	if err != nil {
		return nil, err
	}
	defer detached.Release()
	writes := make([]index.DocumentWrite, 0, 2*len(entries))
	add := func(id string, logged []byte) error {
		write, err := handle.DetachedWriteOf(id, logged)
		if err == nil {
			writes = append(writes, write)
		}
		return err
	}
	for at, entry := range entries {
		if entry.Operation == wal.OperationIndex {
			if err := add(afterWriteID(at), entry.Document); err != nil {
				return nil, err
			}
		}
		if entry.Previous == wal.PreviousDocumentHeld {
			if err := add(beforeWriteID(at), entry.PreviousDocument); err != nil {
				return nil, err
			}
		}
	}
	failures, err := detached.Apply(index.WriteInsert, writes, nil)
	if err != nil {
		return nil, err
	}
	for _, failure := range failures {
		if failure != nil {
			return nil, failure
		}
	}
	matched, err := detached.MatchingIDs(ctx, filter)
	if err != nil {
		return nil, err
	}
	results := make([]FilterMatch, len(entries))
	for at := range entries {
		_, before := matched[beforeWriteID(at)]
		_, after := matched[afterWriteID(at)]
		results[at] = FilterMatch{Before: before, After: after}
	}
	return results, nil
}
