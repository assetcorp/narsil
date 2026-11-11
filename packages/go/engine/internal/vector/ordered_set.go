package vector

type orderedEntry struct {
	docID string
	live  bool
}

type orderedSet struct {
	positions map[string]int
	entries   []orderedEntry
}

func newOrderedSet() *orderedSet {
	return &orderedSet{positions: map[string]int{}}
}

func (s *orderedSet) size() int {
	return len(s.positions)
}

func (s *orderedSet) has(docID string) bool {
	_, held := s.positions[docID]
	return held
}

func (s *orderedSet) add(docID string) {
	if s.has(docID) {
		return
	}
	s.positions[docID] = len(s.entries)
	s.entries = append(s.entries, orderedEntry{docID: docID, live: true})
}

func (s *orderedSet) delete(docID string) bool {
	position, held := s.positions[docID]
	if !held {
		return false
	}
	delete(s.positions, docID)
	s.entries[position].live = false
	if len(s.entries) > 2*len(s.positions)+vectorStoreInitialCapacity {
		s.compact()
	}
	return true
}

func (s *orderedSet) compact() {
	kept := s.entries[:0]
	for _, entry := range s.entries {
		if !entry.live {
			continue
		}
		s.positions[entry.docID] = len(kept)
		kept = append(kept, entry)
	}
	clear(s.entries[len(kept):])
	s.entries = kept
}

func (s *orderedSet) clear() {
	clear(s.positions)
	s.entries = s.entries[:0]
}

func (s *orderedSet) values() []string {
	values := make([]string, 0, len(s.positions))
	for _, entry := range s.entries {
		if entry.live {
			values = append(values, entry.docID)
		}
	}
	return values
}
