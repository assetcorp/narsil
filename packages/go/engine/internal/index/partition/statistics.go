package partition

type statistics struct {
	totalDocuments    int
	totalFieldLengths map[string]float64
}

func newStatistics() statistics {
	return statistics{totalFieldLengths: map[string]float64{}}
}

func (s *statistics) addDocument(fieldLengths map[string]uint32) {
	s.totalDocuments++
	for field, length := range fieldLengths {
		s.totalFieldLengths[field] += float64(length)
	}
}

func (s *statistics) removeDocument(fieldLengths map[string]uint32) {
	if s.totalDocuments == 0 {
		return
	}
	s.totalDocuments--
	for field, length := range fieldLengths {
		total, found := s.totalFieldLengths[field]
		if !found {
			continue
		}
		total -= float64(length)
		if total <= 0 {
			delete(s.totalFieldLengths, field)
			continue
		}
		s.totalFieldLengths[field] = total
	}
}

func (s *statistics) averageFieldLength(field string) (float64, bool) {
	total, found := s.totalFieldLengths[field]
	if !found {
		return 0, false
	}
	if s.totalDocuments == 0 {
		return 0, true
	}
	return total / float64(s.totalDocuments), true
}

func (s *statistics) averageFieldLengths() map[string]float64 {
	averages := make(map[string]float64, len(s.totalFieldLengths))
	for field := range s.totalFieldLengths {
		averages[field], _ = s.averageFieldLength(field)
	}
	return averages
}

func (s *statistics) totals() map[string]float64 {
	copied := make(map[string]float64, len(s.totalFieldLengths))
	for field, total := range s.totalFieldLengths {
		copied[field] = total
	}
	return copied
}
