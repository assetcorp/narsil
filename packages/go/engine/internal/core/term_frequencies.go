package core

func (d *TermDictionary) termCount() (int, bool) {
	if len(d.Removed) != len(d.Frequencies) {
		return 0, false
	}
	if d.Growing == nil {
		return len(d.Frequencies), true
	}
	if len(d.Growing.Header) <= TermHeaderCount {
		return 0, false
	}
	return min(int(d.Growing.Header[TermHeaderCount]), len(d.Frequencies)), true
}

func DocumentFrequencies(dictionary *TermDictionary, tokens, frequencies []uint32) error {
	if dictionary == nil || len(frequencies) < len(tokens) {
		return &StatusError{Operation: "documentFrequency", Status: StatusInvalidArgument}
	}
	count, valid := dictionary.termCount()
	if !valid {
		return &StatusError{Operation: "documentFrequency", Status: StatusInvalidArgument}
	}
	for at, token := range tokens {
		if int64(token) >= int64(count) {
			return &StatusError{Operation: "documentFrequency", Status: StatusInvalidArgument}
		}
		stored, removed := dictionary.Frequencies[token], dictionary.Removed[token]
		frequencies[at] = 0
		if removed <= stored {
			frequencies[at] = stored - removed
		}
	}
	return nil
}
