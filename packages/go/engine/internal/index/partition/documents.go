package partition

import (
	"math/bits"
	"sync"
	"sync/atomic"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type storedDocument struct {
	id      string
	encoded []byte
}

type documentEntry struct {
	id      string
	encoded [sideCount][]byte
}

type documentTable struct {
	writing  sync.Mutex
	reserved uint32
	chunks   atomic.Pointer[[][]documentEntry]
}

func newDocumentTable() *documentTable {
	return &documentTable{}
}

func documentChunkOf(ordinal uint32) (int, uint64) {
	doubled := uint64(ordinal)>>documentTableFirstChunkBits + 1
	chunk := bits.Len64(doubled) - 1
	first := (uint64(1)<<chunk - 1) << documentTableFirstChunkBits
	return chunk, uint64(ordinal) - first
}

func (t *documentTable) entryAt(ordinal uint32) *documentEntry {
	chunks := t.chunks.Load()
	if chunks == nil {
		return nil
	}
	chunk, offset := documentChunkOf(ordinal)
	if chunk >= len(*chunks) {
		return nil
	}
	return &(*chunks)[chunk][offset]
}

func (t *documentTable) reserve(id string) uint32 {
	t.writing.Lock()
	defer t.writing.Unlock()
	ordinal := t.reserved
	chunk, offset := documentChunkOf(ordinal)
	var held [][]documentEntry
	if current := t.chunks.Load(); current != nil {
		held = *current
	}
	if chunk >= len(held) {
		grown := append(held, make([]documentEntry, uint64(1)<<(chunk+documentTableFirstChunkBits)))
		t.chunks.Store(&grown)
		held = grown
	}
	held[chunk][offset].id = id
	t.reserved++
	return ordinal
}

func (t *documentTable) set(side int, ordinal uint32, encoded []byte) {
	t.writing.Lock()
	defer t.writing.Unlock()
	if ordinal >= t.reserved {
		return
	}
	if entry := t.entryAt(ordinal); entry != nil {
		entry.encoded[side] = encoded
	}
}

func (t *documentTable) at(side int, ordinal uint32) (storedDocument, bool) {
	entry := t.entryAt(ordinal)
	if entry == nil {
		return storedDocument{}, false
	}
	encoded := entry.encoded[side]
	if encoded == nil {
		return storedDocument{}, false
	}
	return storedDocument{id: entry.id, encoded: encoded}, true
}

var storedDecoding = codec.DecodeOptions{ErrorCode: narsilerr.CodePartitionCorrupted}

func decodeStored(document storedDocument) (*codec.Document, error) {
	return codec.DecodeStoredDocument(document.encoded, storedDecoding)
}
