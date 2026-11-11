package partition

func (s Snapshot) Locate(id string) (int, uint32, bool, error) {
	at, err := s.side.locate(id)
	if err != nil || !at.found {
		return 0, 0, false, err
	}
	if at.frozen < 0 {
		return len(s.side.frozen), at.ordinal, true, nil
	}
	return at.frozen, at.ordinal, true, nil
}
