package growing

type nonemptyChange uint8

const (
	nonemptyUnchanged nonemptyChange = iota
	nonemptyFollowsLiveTerms
	nonemptyUnknown
)

type nonemptyTerms struct {
	count     uint64
	liveTerms uint32
	stale     bool
}

func (s *Segment) countsNonemptyTerms() nonemptyChange {
	if !s.nonempty.stale && uint64(s.nonempty.liveTerms) == s.nonempty.count {
		return nonemptyFollowsLiveTerms
	}
	return nonemptyUnknown
}

func (s *Segment) acceptNonempty(change nonemptyChange, compacted bool) {
	live := s.terms.ids.header[headerLiveCount]
	switch {
	case compacted || change == nonemptyUnknown:
		s.nonempty.stale = true
	case change == nonemptyFollowsLiveTerms:
		s.nonempty.count = uint64(int64(s.nonempty.count) + int64(live) - int64(s.nonempty.liveTerms))
	}
	s.nonempty.liveTerms = live
}

func (s *Segment) NonemptyTerms() uint64 {
	if s.released {
		return 0
	}
	if !s.nonempty.stale {
		return s.nonempty.count
	}
	terms := s.terms
	count := min(uint64(terms.ids.header[headerCount]), terms.flags.len())
	nonempty := uint64(0)
	for ordinal := range count {
		if terms.flags.values[ordinal]&termLiveFlag != 0 &&
			terms.docFrequency.values[ordinal] > terms.deadDocuments.values[ordinal] {
			nonempty++
		}
	}
	s.nonempty.count = nonempty
	s.nonempty.stale = false
	return nonempty
}
