package codec

import "strings"

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
