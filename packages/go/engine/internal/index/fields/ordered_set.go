package fields

type orderedSet struct {
	members  []uint32
	alive    []bool
	position map[uint32]int
}

func newOrderedSet() *orderedSet {
	return &orderedSet{position: map[uint32]int{}}
}

func (s *orderedSet) has(ordinal uint32) bool {
	_, held := s.position[ordinal]
	return held
}

func (s *orderedSet) add(ordinal uint32) bool {
	if s.has(ordinal) {
		return false
	}
	s.position[ordinal] = len(s.members)
	s.members = append(s.members, ordinal)
	s.alive = append(s.alive, true)
	return true
}

func (s *orderedSet) remove(ordinal uint32) bool {
	at, held := s.position[ordinal]
	if !held {
		return false
	}
	delete(s.position, ordinal)
	s.alive[at] = false
	if len(s.members) > 2*len(s.position)+runListInitialCapacity {
		s.compact()
	}
	return true
}

func (s *orderedSet) compact() {
	kept := 0
	for at, ordinal := range s.members {
		if !s.alive[at] {
			continue
		}
		s.members[kept] = ordinal
		s.alive[kept] = true
		s.position[ordinal] = kept
		kept++
	}
	s.members = s.members[:kept]
	s.alive = s.alive[:kept]
}

func (s *orderedSet) size() int {
	return len(s.position)
}

func (s *orderedSet) each(visit func(ordinal uint32)) {
	for at, ordinal := range s.members {
		if s.alive[at] {
			visit(ordinal)
		}
	}
}
