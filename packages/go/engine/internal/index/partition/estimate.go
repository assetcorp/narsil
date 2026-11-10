package partition

func (s *side) sideIndexBytes() int {
	documentCount := s.documents.count
	textFieldCount := len(s.statistics.totalFieldLengths)
	fieldIndexCount := len(s.numbers) + len(s.booleans) + len(s.enums) + len(s.geopoints) + len(s.sizes)
	bytes := documentCount * documentEntryOverheadBytes
	bytes += textFieldCount * int(s.documents.capacity()) * lengthColumnSlotBytes
	bytes += s.postings.EstimateBytes()
	bytes += s.postings.Size() * documentFrequencyBytes
	bytes += s.surfaces.size() * surfaceEntryOverheadBytes
	bytes += documentCount * fieldIndexCount * fieldEntryOverheadBytes
	for _, index := range s.patterns {
		bytes += index.Bytes()
	}
	return bytes + s.partial.Bytes()
}

func (s *side) estimateBytes() int {
	if s.documents.count == 0 {
		return 0
	}
	return s.documents.contentBytes + sidesPerPartition*s.sideIndexBytes()
}

func (f *frozenSub) estimateBytes() int {
	bytes := f.segment.StaticBytes()
	if f.removedCount > 0 {
		bytes += f.segment.RemovalIndexBytes()
	}
	if f.partial != nil {
		bytes += f.partial.Bytes()
	}
	return bytes
}

func (v View) EstimateBytes() int {
	bytes := v.state.estimateBytes()
	if v.tailOnly {
		return bytes
	}
	for _, sub := range v.state.frozen {
		bytes += sub.estimateBytes()
	}
	return bytes
}
