package persist

import (
	"context"
	"slices"
	"sync"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/segments"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/checkpoint"
)

type removalPageCache struct {
	once  sync.Once
	pages *core.PageCache
	err   error
}

func (held *removalPageCache) get() (*core.PageCache, error) {
	held.once.Do(func() {
		held.pages, held.err = segments.NewRemovalPageCache()
	})
	return held.pages, held.err
}

func routesWhole(target *index.Index, partitionID int, segment checkpoint.StoredSegment) bool {
	if partitionID < 0 || partitionID >= target.PartitionCount() {
		return false
	}
	for ordinal := range segment.DocumentTotal() {
		if target.RoutePartition(segment.DocumentID(ordinal)) != partitionID {
			return false
		}
	}
	return true
}

func attachStored(target *index.Index, partitionID int, segment checkpoint.StoredSegment) error {
	file, held := segment.KeywordFile()
	if !held {
		return narsilerr.New(narsilerr.CodePersistenceLoadFailed,
			"A segment that stores its text on disk needs a durable directory to be read from",
			map[string]any{"partitionId": partitionID})
	}
	documents := make([][]byte, segment.DocumentTotal())
	for ordinal := range documents {
		encoded, err := segment.EncodedDocument(ordinal)
		if err != nil {
			return err
		}
		documents[ordinal] = slices.Clone(encoded)
	}
	return target.AttachSegmentFile(partitionID, file, documents)
}

type pagedAttachment struct {
	target      *index.Index
	pages       *core.PageCache
	partitionID int
	key         string
	path        string
	schema      map[string]string
	replaced    func(tombstones []string)
}

func attachPagedListed(ctx context.Context, handle *Handle, partitionID int, key string, path string,
	schema map[string]string) error {
	pages, err := handle.removalPages.get()
	if err != nil {
		return err
	}
	return attachPagedFile(ctx, pagedAttachment{target: handle.Index, pages: pages, partitionID: partitionID, key: key,
		path: path, schema: schema})
}

func attachPagedFile(ctx context.Context, attachment pagedAttachment) error {
	target, partitionID, key := attachment.target, attachment.partitionID, attachment.key
	err := target.AttachPagedSegmentFile(partitionID, index.PagedSegmentFile{Path: attachment.path,
		RemovalPages: attachment.pages,
		Replaces: func(fieldSchema map[string]string, tombstones []string) error {
			if err := checkpoint.RequireAgreedSchema(attachment.schema, fieldSchema, key); err != nil {
				return err
			}
			if attachment.replaced != nil {
				attachment.replaced(tombstones)
			}
			replaced, err := heldDocumentIDs(ctx, target, tombstones)
			if err != nil {
				return err
			}
			return applyInBatches(target, index.WriteRemove, removalsOf(replaced), firstFailure)
		}})
	if err != nil {
		return narsilerr.Passthrough(err, narsilerr.CodePersistenceLoadFailed,
			"A checkpoint segment cannot be attached to its partition")
	}
	return nil
}

func loadListedSegment(ctx context.Context, store checkpoint.Store, handle *Handle, partitionID int,
	ref manifest.FileRef, schema map[string]string) error {
	pagedText := textStoredOnDisk(handle)
	if pagedText {
		path, paged, err := checkpoint.ListedPagedPath(ctx, store, ref)
		if err != nil {
			return err
		}
		if paged {
			return attachPagedListed(ctx, handle, partitionID, ref.Key, path, schema)
		}
	}
	segment, err := checkpoint.OpenStoredSegment(ctx, store, ref, pagedText)
	if err != nil {
		return err
	}
	if err := checkpoint.RequireAgreedSchema(schema, segment.FieldSchema(), ref.Key); err != nil {
		return err
	}
	return loadSegment(ctx, handle.Index, partitionID, segment)
}
