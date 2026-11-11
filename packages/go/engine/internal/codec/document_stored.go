package codec

import (
	"slices"
	"strings"
	"unsafe"

	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

func NewStoredDocument(stored []byte, options DecodeOptions) *Document {
	return storedDocument(append(make([]byte, 0, len(stored)), stored...), false, options)
}

func ShareStoredDocument(stored []byte, options DecodeOptions) *Document {
	return storedDocument(stored[:len(stored):len(stored)], true, options)
}

func storedDocument(stored []byte, borrowed bool, options DecodeOptions) *Document {
	state := newDocumentState()
	state.stored = stored
	state.borrowed = borrowed
	state.errorCode = options.ErrorCode
	state.depth = 1
	return &state.handle
}

func DecodeStoredDocument(stored []byte, options DecodeOptions) (*Document, error) {
	document := NewStoredDocument(stored, options)
	return document, DocumentFailure(document)
}

func (s *documentState) decode() {
	s.opened = true
	if s.stored == nil {
		return
	}
	shared := s.shared
	if shared == "" && s.borrowed {
		shared = unsafe.String(unsafe.SliceData(s.stored), len(s.stored))
	} else if shared == "" {
		shared = string(s.stored)
	}
	decoder := NewDecoder(s.stored, DecodeOptions{ErrorCode: s.errorCode, ShareBinary: !s.borrowed})
	decoder.shared = shared
	entries, err := decoder.readDocumentEntries(s)
	if err != nil {
		s.failure = err
		return
	}
	s.entries = entries
	s.indexKeys()
	for _, later := range s.later {
		s.putPath(later.path, later.value)
	}
	s.later = nil
}

func StoredDocumentFailure(document *Document) error {
	state := document.readable()
	if state == nil {
		return nil
	}
	failure := state.firstFailure()
	if failure == nil {
		return nil
	}
	if stored := state.stored; len(stored) > 0 && typeOfTag(stored[0]) != TypeMap {
		_, err := UnmarshalAsJavaScript(stored, DecodeOptions{})
		if err == nil {
			return narsilerr.New(narsilerr.CodePersistenceLoadFailed,
				"A stored document decodes to something other than a map", nil).CausedBy(failure)
		}
		failure = err
	}
	return narsilerr.New(narsilerr.CodePersistenceLoadFailed,
		"A stored document is not MessagePack: "+strings.TrimPrefix(messageOf(failure), decodingFailurePrefix), nil).CausedBy(failure)
}

func (decoder *Decoder) readDocumentEntries(state *documentState) ([]documentEntry, error) {
	tag, err := decoder.peekTag()
	if err != nil {
		return nil, err
	}
	if typeOfTag(tag) != TypeMap {
		return nil, decoder.Errorf("a document must be a map, but found type byte 0x%02x", tag)
	}
	if state.depth > decoder.maxDepth {
		return nil, decoder.Errorf("the value nests deeper than %d levels", decoder.maxDepth)
	}
	count, err := decoder.ReadMapHeader()
	if err != nil {
		return nil, err
	}
	entries := make([]documentEntry, 0, min(count, decodePreallocatedEntries))
	var positions map[string]int
	if count > indexedDocumentKeys {
		positions = make(map[string]int, min(count, decodePreallocatedEntries))
	}
	holdsIndexKey := false
	for range count {
		key, err := decoder.readMapKey()
		if err != nil {
			return nil, err
		}
		start := decoder.position
		value, err := decoder.readHeldValue(state, state.depth+1)
		if err != nil {
			return nil, err
		}
		entry := documentEntry{key: key, value: value, raw: decoder.data[start:decoder.position:decoder.position]}
		if position, seen := positionAmong(entries, positions, key); seen {
			entries[position] = entry
			continue
		}
		if positions != nil {
			positions[key] = len(entries)
		}
		if _, isIndex := arrayIndexOf(key); isIndex {
			holdsIndexKey = true
		}
		entries = append(entries, entry)
	}
	if err := decoder.requireEnd(); err != nil {
		return nil, err
	}
	if holdsIndexKey {
		entries = inPropertyOrder(entries, func(entry documentEntry) string { return entry.key })
	}
	return entries, nil
}

func positionAmong(entries []documentEntry, positions map[string]int, key string) (int, bool) {
	if positions != nil {
		position, seen := positions[key]
		return position, seen
	}
	for position := range entries {
		if entries[position].key == key {
			return position, true
		}
	}
	return 0, false
}

func (decoder *Decoder) readHeldValue(parent *documentState, depth int) (any, error) {
	start := decoder.position
	value, err := decoder.readHeldValueAt(parent, depth)
	if err == nil {
		return value, nil
	}
	decoder.position = start
	if decoder.Skip() != nil {
		return nil, err
	}
	parent.noteFault(err)
	return faultyValue{failure: err, list: typeOfTag(decoder.data[start]) == TypeArray}, nil
}

func (decoder *Decoder) readHeldValueAt(parent *documentState, depth int) (any, error) {
	tag, err := decoder.peekTag()
	if err != nil {
		return nil, err
	}
	switch typeOfTag(tag) {
	case TypeMap:
		return decoder.readNestedDocument(parent, depth)
	case TypeArray:
		if depth > decoder.maxDepth {
			return nil, decoder.Errorf("the value nests deeper than %d levels", decoder.maxDepth)
		}
		count, err := decoder.ReadArrayHeader()
		if err != nil {
			return nil, err
		}
		list := make([]any, 0, min(count, decodePreallocatedEntries))
		for range count {
			if len(list) == cap(list) {
				list = slices.Grow(list, min(count-len(list), len(list)))
			}
			element, err := decoder.readHeldValue(parent, depth+1)
			if err != nil {
				return nil, err
			}
			list = append(list, element)
		}
		return list, nil
	}
	return decoder.readValue(depth, exactDecoding)
}

func (decoder *Decoder) readNestedDocument(parent *documentState, depth int) (any, error) {
	start := decoder.position
	fault := decoder.heldFault(depth)
	if fault != nil {
		parent.noteFault(fault)
		decoder.position = start
		if err := decoder.Skip(); err != nil {
			return nil, err
		}
	}
	nested := newDocumentState()
	nested.fault = fault
	nested.stored = decoder.data[start:decoder.position:decoder.position]
	nested.borrowed = parent.borrowed
	nested.shared = decoder.shared[start:decoder.position]
	nested.errorCode, nested.depth, nested.parent = decoder.errorCode, depth, parent
	return &nested.handle, nil
}
