package partition

import (
	"sync/atomic"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/segments"
)

type documentSource interface {
	DocumentAt(ordinal uint32) ([]byte, error)
}

type frozenSegment struct {
	frozen    *segments.Frozen
	paged     *segments.Paged
	ids       []string
	ordinals  map[string]uint32
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
	ordinals := make(map[string]uint32, len(ids))
	for ordinal, id := range ids {
		ordinals[id] = uint32(ordinal)
	}
	return &frozenSegment{frozen: frozen, ids: ids, ordinals: ordinals, documents: documents}
}

func (f *frozenSegment) keyword() *segments.Keyword {
	return &f.frozen.Keyword
}

func (f *frozenSegment) documentCount() uint32 {
	return uint32(len(f.ids))
}

func (f *frozenSegment) ordinalOf(id string) (uint32, bool) {
	ordinal, found := f.ordinals[id]
	return ordinal, found
}

func (f *frozenSegment) idAt(ordinal uint32) (string, bool) {
	if uint64(ordinal) >= uint64(len(f.ids)) {
		return "", false
	}
	return f.ids[ordinal], true
}

func (f *frozenSegment) documentAt(ordinal uint32) (storedDocument, bool, error) {
	id, held := f.idAt(ordinal)
	if !held {
		return storedDocument{}, false, nil
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
	return storedDocument{id: id, encoded: encoded}, true, nil
}

func (f *frozenSegment) newState() *segments.State {
	if f.paged != nil {
		return f.paged.NewState()
	}
	return segments.NewState(f.keyword(), nil)
}
