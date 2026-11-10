package frozen

func valueRowBytes(index interface{ Entries() ([]float64, []uint32) }) int {
	values, _ := index.Entries()
	return len(values) * (uint32Bytes + float64Bytes)
}

func (s *Segment) StaticBytes() int {
	return s.staticBytes
}

func (s *Segment) measureStaticBytes() int {
	tokens := s.TokenCount()
	bytes := len(s.tokenText) + (tokens+1)*uint32Bytes + tokens*uint32Bytes*2
	documents := s.DocumentCount()
	bytes += s.idBytes + (documents+1)*uint32Bytes + documents*uint32Bytes
	bytes += len(s.postingOffsets) * uint32Bytes
	bytes += len(s.postingDocuments)*uint32Bytes + len(s.postingFrequencies)*uint16Bytes + len(s.postingFields)*uint16Bytes
	if s.positionOffsets != nil {
		bytes += len(s.positionOffsets)*uint32Bytes + len(s.positions)*uint32Bytes
	}
	bytes += s.residentFileBytes
	if s.text == nil {
		bytes += s.encodedBytes + (documents+1)*uint32Bytes
	}
	for _, column := range s.lengthColumns {
		bytes += len(column) * uint32Bytes
	}
	for _, index := range s.indexes.Numbers {
		bytes += valueRowBytes(index)
	}
	for _, index := range s.indexes.Sizes {
		bytes += valueRowBytes(index)
	}
	for _, index := range s.indexes.Booleans {
		trueOrdinals, falseOrdinals := index.Ordinals()
		bytes += (len(trueOrdinals) + len(falseOrdinals)) * uint32Bytes
	}
	for _, index := range s.indexes.Enums {
		postings := index.Postings()
		bytes += (len(postings) + 1) * uint32Bytes
		for _, posting := range postings {
			bytes += len(posting.Ordinals) * uint32Bytes
		}
	}
	for _, index := range s.indexes.Geopoints {
		bytes += index.Count() * (uint32Bytes + 2*float64Bytes)
	}
	for _, index := range s.patterns {
		bytes += index.Bytes()
	}
	return bytes
}

func (s *Segment) RemovalIndexBytes() int {
	tokens := s.TokenCount()
	return (s.DocumentCount()+1)*uint32Bytes + len(s.postingDocuments)*uint32Bytes + tokens*uint32Bytes*2 + tokens*float64Bytes
}
