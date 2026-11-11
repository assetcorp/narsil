package checkpoint

import (
	"context"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/keyword"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/paged"
)

type StoredSegment interface {
	FieldSchema() map[string]string
	RemovedIDs() []string
	DocumentTotal() int
	DocumentID(ordinal int) string
	StoredDocument(ordinal int) (map[string]any, error)
	EncodedDocument(ordinal int) ([]byte, error)
	KeywordFile() (*keyword.Segment, bool)
}

func (stored keywordStored) KeywordFile() (*keyword.Segment, bool) { return stored.segment, true }

func (pagedStored) KeywordFile() (*keyword.Segment, bool) { return nil, false }

type keywordStored struct {
	segment *keyword.Segment
}

func (stored keywordStored) FieldSchema() map[string]string { return stored.segment.Schema }

func (stored keywordStored) RemovedIDs() []string { return stored.segment.Tombstones }

func (stored keywordStored) DocumentTotal() int { return int(stored.segment.DocumentCount) }

func (stored keywordStored) DocumentID(ordinal int) string { return stored.segment.ID(ordinal) }

func (stored keywordStored) StoredDocument(ordinal int) (map[string]any, error) {
	return stored.segment.Document(ordinal)
}

func (stored keywordStored) EncodedDocument(ordinal int) ([]byte, error) {
	return stored.segment.EncodedDocument(ordinal), nil
}

type pagedStored struct {
	reader *paged.Reader
	ids    []string
}

func (stored pagedStored) FieldSchema() map[string]string { return stored.reader.Head.Schema }

func (stored pagedStored) RemovedIDs() []string { return stored.reader.Head.Tombstones }

func (stored pagedStored) DocumentTotal() int { return len(stored.ids) }

func (stored pagedStored) DocumentID(ordinal int) string { return stored.ids[ordinal] }

func (stored pagedStored) StoredDocument(ordinal int) (map[string]any, error) {
	return stored.reader.Document(uint32(ordinal))
}

func (stored pagedStored) EncodedDocument(ordinal int) ([]byte, error) {
	return stored.reader.EncodedDocument(uint32(ordinal))
}

func holdsPagedText(data []byte) bool {
	if len(data) < envelope.HeaderBytes {
		return false
	}
	header, err := envelope.ParseHeader(data)
	return err == nil && header.FormatVersion == paged.EnvelopeVersion
}

func openPaged(ref manifest.FileRef, data []byte) (StoredSegment, error) {
	reader, err := paged.OpenBytes(data)
	if err != nil {
		return nil, err
	}
	if err := RequireChecksum(ref, reader.Header, "segment"); err != nil {
		return nil, err
	}
	if err := reader.CheckFully(); err != nil {
		return nil, err
	}
	ids := make([]string, reader.Head.DocumentCount)
	for ordinal := range ids {
		id, err := reader.IDBytes(uint32(ordinal))
		if err != nil {
			return nil, err
		}
		ids[ordinal] = string(id)
	}
	return pagedStored{reader: reader, ids: ids}, nil
}

func OpenStoredSegment(ctx context.Context, store Store, ref manifest.FileRef, pagedText bool) (StoredSegment,
	error) {
	data, err := ReadListed(ctx, store, ref, "segment")
	if err != nil {
		return nil, err
	}
	if pagedText && holdsPagedText(data) {
		return openPaged(ref, data)
	}
	segment, err := openKeyword(ref, data)
	if err != nil {
		return nil, err
	}
	return keywordStored{segment: segment}, nil
}
