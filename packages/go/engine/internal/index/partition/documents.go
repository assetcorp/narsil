package partition

import (
	"sort"
	"sync/atomic"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/bitset"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/stored"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type StoredDocument = stored.Document

type documentStore struct {
	ordinals      map[string]uint32
	documents     []*StoredDocument
	lengthColumns map[string][]uint32
	count         int
	contentBytes  int
	live          bitset.Bits
	sortedIDs     atomic.Pointer[[]string]
}

func newDocumentStore() documentStore {
	return documentStore{ordinals: map[string]uint32{}, lengthColumns: map[string][]uint32{}, live: bitset.New(0)}
}

func (s *documentStore) get(id string) (*StoredDocument, uint32, bool) {
	ordinal, found := s.ordinals[id]
	if !found {
		return nil, 0, false
	}
	return s.documents[ordinal], ordinal, true
}

func (s *documentStore) at(ordinal uint32) *StoredDocument {
	if int(ordinal) >= len(s.documents) {
		return nil
	}
	return s.documents[ordinal]
}

func (s *documentStore) capacity() uint32 {
	return uint32(len(s.documents))
}

func (s *documentStore) store(document *StoredDocument) uint32 {
	ordinal, found := s.ordinals[document.ID]
	if found {
		s.contentBytes -= s.documents[ordinal].ContentBytes
	} else {
		ordinal = uint32(len(s.documents))
		s.ordinals[document.ID] = ordinal
		s.documents = append(s.documents, nil)
		s.count++
		s.live = bitset.Grown(s.live, ordinal)
		s.live.Set(ordinal)
		s.sortedIDs.Store(nil)
	}
	s.documents[ordinal] = document
	s.contentBytes += document.ContentBytes
	s.writeFieldLengths(ordinal, document.FieldLengths)
	return ordinal
}

func (s *documentStore) writeFieldLengths(ordinal uint32, lengths map[string]uint32) {
	for field, length := range lengths {
		column := s.lengthColumns[field]
		if int(ordinal) >= len(column) {
			grown := make([]uint32, max(int(ordinal)+1, len(column)*2, firstLengthColumnCapacity))
			copy(grown, column)
			column = grown
			s.lengthColumns[field] = column
		}
		column[ordinal] = length
	}
}

func (s *documentStore) remove(id string) (uint32, bool) {
	ordinal, found := s.ordinals[id]
	if !found {
		return 0, false
	}
	s.contentBytes -= s.documents[ordinal].ContentBytes
	s.count--
	s.live.Clear(ordinal)
	delete(s.ordinals, id)
	s.documents[ordinal] = nil
	s.sortedIDs.Store(nil)
	for _, column := range s.lengthColumns {
		if int(ordinal) < len(column) {
			column[ordinal] = 0
		}
	}
	return ordinal, true
}

func (s *documentStore) forEach(visit func(ordinal uint32, document *StoredDocument) bool) {
	for ordinal, document := range s.documents {
		if document != nil && !visit(uint32(ordinal), document) {
			return
		}
	}
}

func (s *documentStore) sortedDocumentIDs() []string {
	if held := s.sortedIDs.Load(); held != nil {
		return *held
	}
	ids := make([]string, 0, s.count)
	s.forEach(func(_ uint32, document *StoredDocument) bool {
		ids = append(ids, document.ID)
		return true
	})
	sort.Slice(ids, func(left, right int) bool { return text.CompareCodePoints(ids[left], ids[right]) < 0 })
	s.sortedIDs.CompareAndSwap(nil, &ids)
	return ids
}
