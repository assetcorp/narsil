package partition

func (s Snapshot) Locate(id string) (int, uint32, bool) {
	at := s.side.locate(id)
	if !at.found {
		return 0, 0, false
	}
	if at.frozen < 0 {
		return len(s.side.frozen), at.ordinal, true
	}
	return at.frozen, at.ordinal, true
}
