package corepartition

import (
	"sync"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type storedDocument struct {
	id      string
	encoded []byte
}

type documentEntry struct {
	id      string
	encoded [2][]byte
}

type documentTable struct {
	mu      sync.RWMutex
	entries []documentEntry
}

func newDocumentTable() *documentTable {
	return &documentTable{}
}

func (t *documentTable) reserve(id string) uint32 {
	t.mu.Lock()
	defer t.mu.Unlock()
	ordinal := uint32(len(t.entries))
	t.entries = append(t.entries, documentEntry{id: id})
	return ordinal
}

func (t *documentTable) set(side int, ordinal uint32, encoded []byte) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if uint64(ordinal) < uint64(len(t.entries)) {
		t.entries[ordinal].encoded[side] = encoded
	}
}

func (t *documentTable) at(side int, ordinal uint32) (storedDocument, bool) {
	t.mu.RLock()
	defer t.mu.RUnlock()
	if uint64(ordinal) >= uint64(len(t.entries)) {
		return storedDocument{}, false
	}
	entry := t.entries[ordinal]
	if entry.encoded[side] == nil {
		return storedDocument{}, false
	}
	return storedDocument{id: entry.id, encoded: entry.encoded[side]}, true
}

func decodeStored(document storedDocument) (map[string]any, error) {
	return codec.DecodeDocument(document.encoded, codec.DecodeOptions{ErrorCode: narsilerr.CodePartitionCorrupted})
}
