package codec

import (
	"bytes"
	"slices"
	"strings"
	"unsafe"
)

type HeldEntry struct {
	Value  any
	Stored []byte
}

func PutHeld(document *Document, key string, value any) {
	document.writable().put(key, value)
}

func PutHeldPath(document *Document, path string, value any) {
	if state := document.held; state != nil && state.stored != nil && !state.opened {
		state.markChanged()
		state.later = append(state.later, heldPath{path: path, value: value})
		return
	}
	document.writable().putPath(path, value)
}

type nullLeftOut struct{}

func LeaveOutNullsAt(document *Document, paths []string) {
	if len(paths) == 0 || document == nil {
		return
	}
	if state := document.held; state != nil && state.stored != nil && !state.opened {
		if bytes.IndexByte(state.stored, tagNil) < 0 {
			return
		}
		for _, path := range paths {
			if storedHoldsNullAt(state.stored, path) {
				state.markChanged()
				state.later = append(state.later, heldPath{path: path, value: nullLeftOut{}})
			}
		}
		return
	}
	if state := document.readable(); state != nil {
		for _, path := range paths {
			state.dropNullAt(path)
		}
	}
}

func mayBeStoredAsNumberKey(leaf string) bool {
	return leaf == "" || leaf[0] == '-' || (leaf[0] >= '0' && leaf[0] <= '9') || leaf == "NaN" || leaf == "Infinity"
}

func storedMayHoldNullAt(stored []byte, path string) bool {
	leaf := path[strings.LastIndexByte(path, '.')+1:]
	if mayBeStoredAsNumberKey(leaf) {
		return true
	}
	text := unsafe.String(unsafe.SliceData(stored), len(stored))
	for from := 0; from < len(text); {
		at := strings.IndexByte(text[from:], tagNil)
		if at < 0 {
			return false
		}
		at += from
		if strings.HasSuffix(text[:at], leaf) {
			return true
		}
		from = at + 1
	}
	return false
}

func storedHoldsNullAt(stored []byte, path string) bool {
	if !storedMayHoldNullAt(stored, path) {
		return false
	}
	decoder := NewDecoder(stored, DecodeOptions{})
	for {
		segment, rest, nested := strings.Cut(path, ".")
		found, err := decoder.seekLastMapKey(segment)
		if err != nil {
			return true
		}
		if !found {
			return false
		}
		tag, err := decoder.peekTag()
		if err != nil {
			return true
		}
		if !nested {
			return tag == tagNil
		}
		if typeOfTag(tag) != TypeMap {
			return false
		}
		path = rest
	}
}

func (s *documentState) dropNullAt(path string) {
	current := s
	for {
		segment, rest, nested := strings.Cut(path, ".")
		position, known := current.position(segment)
		if !known {
			return
		}
		if !nested {
			if current.entries[position].value == nil {
				current.markChanged()
				current.entries = slices.Delete(current.entries, position, position+1)
				current.indexKeys()
			}
			return
		}
		next, isDocument := current.entries[position].value.(*Document)
		if !isDocument {
			return
		}
		current = next.readable()
		if current == nil {
			return
		}
		path = rest
	}
}

func (s *documentState) putPath(path string, value any) {
	current := s
	for {
		segment, rest, nested := strings.Cut(path, ".")
		if !nested {
			current.put(segment, value)
			return
		}
		var next *Document
		if position, known := current.position(segment); known {
			next, _ = current.entries[position].value.(*Document)
		}
		if next == nil {
			next = NewDocument()
			current.put(segment, next)
		}
		current, path = next.writable(), rest
	}
}

func NewDocumentOfLength(length int) *Document {
	state := newDocumentState()
	state.entries = make([]documentEntry, 0, length)
	return &state.handle
}

type DocumentTransform func(key string, entry HeldEntry) (replacement any, kept bool)

func TransformDocument(document *Document, transform DocumentTransform) *Document {
	source := document.readable()
	state := newDocumentState()
	if source == nil {
		return &state.handle
	}
	state.entries = make([]documentEntry, len(source.entries))
	for at := range source.entries {
		entry := &source.entries[at]
		held := HeldEntry{Value: entry.value}
		if entry.raw != nil && !holdsChangedDocument(entry.value) {
			held.Stored = entry.raw
		}
		replacement, kept := transform(entry.key, held)
		if kept {
			state.entries[at] = documentEntry{key: entry.key, value: entry.value, raw: held.Stored}
			continue
		}
		state.entries[at] = documentEntry{key: entry.key, value: replacement}
	}
	state.indexKeys()
	return &state.handle
}
