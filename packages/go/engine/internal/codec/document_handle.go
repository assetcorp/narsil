package codec

import (
	"iter"
	"slices"
	"sync"
)

const indexedDocumentKeys = 16

type Document struct {
	held *documentState
}

type documentEntry struct {
	key   string
	value any
	raw   []byte
}

type heldPath struct {
	path  string
	value any
}

type documentState struct {
	handle    Document
	decoding  sync.Once
	stored    []byte
	borrowed  bool
	shared    string
	errorCode string
	depth     int
	failure   error
	fault     error
	entries   []documentEntry
	positions map[string]int
	parent    *documentState
	later     []heldPath
	changed   bool
	opened    bool
}

func newDocumentState() *documentState {
	state := &documentState{}
	state.handle.held = state
	return state
}

func NewDocument() *Document {
	return &newDocumentState().handle
}

func (d *Document) readable() *documentState {
	if d == nil || d.held == nil {
		return nil
	}
	d.held.decoding.Do(d.held.decode)
	return d.held
}

func (d *Document) writable() *documentState {
	if d.held == nil {
		d.held = newDocumentState()
	}
	d.held.decoding.Do(d.held.decode)
	return d.held
}

func (s *documentState) position(key string) (int, bool) {
	if s.positions != nil {
		position, known := s.positions[key]
		return position, known
	}
	for position := range s.entries {
		if s.entries[position].key == key {
			return position, true
		}
	}
	return 0, false
}

func (s *documentState) indexKeys() {
	if len(s.entries) <= indexedDocumentKeys {
		s.positions = nil
		return
	}
	s.positions = make(map[string]int, len(s.entries))
	for position := range s.entries {
		s.positions[s.entries[position].key] = position
	}
}

func (s *documentState) markChanged() {
	for state := s; state != nil && !state.changed; state = state.parent {
		state.changed = true
	}
}

func (s *documentState) placeOf(key string) int {
	index, isIndex := arrayIndexOf(key)
	if !isIndex {
		return len(s.entries)
	}
	for position := range s.entries {
		other, otherIsIndex := arrayIndexOf(s.entries[position].key)
		if !otherIsIndex || other > index {
			return position
		}
	}
	return len(s.entries)
}

func (s *documentState) put(key string, value any) {
	s.markChanged()
	if position, known := s.position(key); known {
		s.entries[position].value, s.entries[position].raw = value, nil
		return
	}
	place := s.placeOf(key)
	s.entries = slices.Insert(s.entries, place, documentEntry{key: key, value: value})
	if place == len(s.entries)-1 && s.positions != nil {
		s.positions[key] = place
		return
	}
	s.indexKeys()
}

// Set stores value under key and returns d, so that calls can chain. A key
// that d already holds keeps its place, and a new key that is an array index
// goes among the other array indexes in ascending order, ahead of every
// other key. Set takes its own copy of a list, and it takes a
// map[string]any, at any depth of value, as a nested document whose keys are
// sorted as DocumentFromMap sorts them. A nested *Document is held as it is,
// so a later Set on it changes d too.
func (d *Document) Set(key string, value any) *Document {
	d.writable().put(key, adoptedValue(value))
	return d
}

// Delete removes key from d, and does nothing when d holds no such key.
func (d *Document) Delete(key string) {
	state := d.readable()
	if state == nil {
		return
	}
	position, known := state.position(key)
	if !known {
		return
	}
	state.markChanged()
	state.entries = slices.Delete(state.entries, position, position+1)
	state.indexKeys()
}

// Get returns the value stored under key, and false when d holds no such
// key. A nested object comes back as a *Document and a list as a []any. A
// list and a byte slice are copies, so a change to one reaches d only
// through Set. Get on a nil document returns false.
func (d *Document) Get(key string) (any, bool) {
	value, found := HeldValue(d, key)
	return releasedValue(value), found
}

// Len returns the number of keys that d holds, and 0 for a nil document.
func (d *Document) Len() int {
	state := d.readable()
	if state == nil {
		return 0
	}
	return len(state.entries)
}

// All returns every key and value of d in the order that the engine stores
// them, with each value as Get returns it. A Set or a Delete on d during the
// iteration leaves the rest of the sequence unspecified.
func (d *Document) All() iter.Seq2[string, any] {
	return func(yield func(string, any) bool) {
		for key, value := range HeldEntries(d) {
			if !yield(key, releasedValue(value)) {
				return
			}
		}
	}
}

func HeldValue(document *Document, key string) (any, bool) {
	state := document.readable()
	if state == nil {
		return nil, false
	}
	position, known := state.position(key)
	if !known {
		return nil, false
	}
	return state.entries[position].value, true
}

func HeldEntries(document *Document) iter.Seq2[string, any] {
	return func(yield func(string, any) bool) {
		state := document.readable()
		if state == nil {
			return
		}
		entries := state.entries
		for position := range entries {
			if !yield(entries[position].key, entries[position].value) {
				return
			}
		}
	}
}

func DocumentFailure(document *Document) error {
	state := document.readable()
	if state == nil {
		return nil
	}
	return state.firstFailure()
}

func (s *documentState) firstFailure() error {
	if s.fault != nil {
		return s.fault
	}
	return s.failure
}
