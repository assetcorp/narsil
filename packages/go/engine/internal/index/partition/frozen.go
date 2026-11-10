package partition

import (
	"slices"
	"sync/atomic"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/segments"
)

type documentSource interface {
	DocumentAt(ordinal uint32) ([]byte, error)
}

type frozenSegment struct {
	frozen    *segments.Frozen
	paged     *segments.Paged
	ids       idTable
	documents [][]byte
	source    documentSource
	columns   atomic.Pointer[frozenColumns]
}

func (f *frozenSegment) release() {
	f.columns.Swap(nil).release()
	if f.paged != nil {
		f.paged.Close()
	}
}

func newFrozenSegment(frozen *segments.Frozen, ids []string, documents [][]byte) *frozenSegment {
	return &frozenSegment{frozen: frozen, ids: newResidentIDs(ids), documents: documents}
}

func newPagedFrozenSegment(paged *segments.Paged) *frozenSegment {
	return &frozenSegment{frozen: &paged.Frozen, paged: paged, ids: pagedIDs{paged: paged}, source: paged}
}

func (f *frozenSegment) keyword() *segments.Keyword {
	return &f.frozen.Keyword
}

func (f *frozenSegment) documentCount() uint32 {
	return f.ids.count()
}

func (f *frozenSegment) ordinalOf(id string) (uint32, bool, error) {
	return f.ids.ordinalOf(id)
}

func (f *frozenSegment) idAt(ordinal uint32) (string, bool, error) {
	if ordinal >= f.ids.count() {
		return "", false, nil
	}
	id, err := f.ids.idAt(ordinal)
	return id, err == nil, err
}

func (f *frozenSegment) documentAt(ordinal uint32) (storedDocument, bool, error) {
	id, held, err := f.idAt(ordinal)
	if err != nil || !held {
		return storedDocument{}, false, err
	}
	if f.documents != nil {
		return storedDocument{id: id, encoded: f.documents[ordinal]}, true, nil
	}
	if f.source == nil {
		return storedDocument{}, false, nil
	}
	encoded, err := f.source.DocumentAt(ordinal)
	if err != nil {
		return storedDocument{}, false, err
	}
	return storedDocument{id: id, encoded: slices.Clone(encoded)}, true, nil
}

func (f *frozenSegment) newState() *segments.State {
	if f.paged != nil {
		return f.paged.NewState()
	}
	return segments.NewState(f.keyword(), nil)
}
