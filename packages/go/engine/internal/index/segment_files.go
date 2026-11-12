package index

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/keyword"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/segments"
)

func (ix *Index) AttachSegmentFile(partitionID int, file *keyword.Segment, documents [][]byte) error {
	if err := ix.checkedPartition(partitionID); err != nil {
		return err
	}
	ids := make([]string, file.DocumentCount)
	for ordinal := range ids {
		ids[ordinal] = file.ID(ordinal)
	}
	w, err := core.AcquireWorkspace()
	if err != nil {
		return err
	}
	frozen, err := segments.OpenKeywordFile(w, file)
	w.Release()
	if err != nil {
		return err
	}
	err = ix.Write(func(w *Write) error {
		return ix.partitions[partitionID].Attach(w.write, frozen, ids, documents)
	})
	ix.noteGrowth()
	return err
}

type PagedSegmentFile struct {
	Path         string
	RemovalPages *core.PageCache
	Replaces     func(fieldSchema map[string]string, tombstones []string, documentCount uint32) error
}

func (ix *Index) attachOpenedPaged(partitionID int, paged *segments.Paged, file PagedSegmentFile) (bool, error) {
	err := file.Replaces(paged.FieldSchema(), paged.Tombstones(), paged.DocumentCount())
	if err != nil || paged.DocumentCount() == 0 {
		return false, err
	}
	return true, ix.Write(func(w *Write) error {
		return ix.partitions[partitionID].AttachPaged(w.write, paged)
	})
}

func (ix *Index) AttachPagedSegmentFile(partitionID int, file PagedSegmentFile) error {
	if err := ix.checkedPartition(partitionID); err != nil {
		return err
	}
	w, err := core.AcquireWorkspace()
	if err != nil {
		return err
	}
	paged, err := segments.OpenPaged(w, file.Path, file.RemovalPages)
	w.Release()
	if err != nil {
		return err
	}
	attached, err := ix.attachOpenedPaged(partitionID, paged, file)
	if err != nil || !attached {
		paged.Close()
	}
	return err
}
