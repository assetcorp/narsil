package vector

type storeLocations struct {
	files    *growable
	offsets  *growable
	resource *sharedResource
}

func newStoreLocations(bytes uintptr) (*storeLocations, error) {
	files, err := newGrowable(bytes, (MaxVectorOrdinals+1)*4)
	if err != nil {
		return nil, err
	}
	offsets, err := newGrowable(bytes, (MaxVectorOrdinals+1)*4)
	if err != nil {
		files.release()
		return nil, err
	}
	locations := &storeLocations{files: files, offsets: offsets}
	locations.resource = newSharedResource(func() {
		files.release()
		offsets.release()
	})
	locations.fillInMemory(0)
	return locations, nil
}

func (l *storeLocations) clone() (*storeLocations, error) {
	next, err := newStoreLocations(l.files.length)
	if err != nil {
		return nil, err
	}
	copy(bytesAt(next.files.pointer(), l.files.length), bytesAt(l.files.pointer(), l.files.length))
	copy(bytesAt(next.offsets.pointer(), l.files.length), bytesAt(l.offsets.pointer(), l.files.length))
	return next, nil
}

func (l *storeLocations) fillInMemory(fromBytes uintptr) {
	words := int32Values(l.files.pointer(), int(l.files.length/4))
	for index := int(fromBytes / 4); index < len(words); index++ {
		words[index] = vectorInMemory
	}
}

func (l *storeLocations) growTo(bytes uintptr) error {
	held := l.files.length
	if held >= bytes {
		return nil
	}
	target := nextGrowthTarget(held, bytes, l.files.maxBytes)
	if err := l.offsets.growToExactly(target); err != nil {
		return err
	}
	if err := l.files.growToExactly(target); err != nil {
		return err
	}
	l.fillInMemory(held)
	return nil
}

func (l *storeLocations) fileOf(ordinal int32) int32 {
	return int32Word(l.files.pointer(), int(ordinal)).Load()
}

func (l *storeLocations) offsetOf(ordinal int32) uint32 {
	return uint32Word(l.offsets.pointer(), int(ordinal)).Load()
}

func (l *storeLocations) set(ordinal int32, location diskLocation) {
	uint32Word(l.offsets.pointer(), int(ordinal)).Store(location.offset)
	int32Word(l.files.pointer(), int(ordinal)).Store(location.fileIndex)
}

func (s *storeMemory) keepPublishedLocations(previous *storeLocations) {
	s.forgetUnreadLocations()
	s.publishedLocations = append(s.publishedLocations, previous)
}

func (s *storeMemory) forgetUnreadLocations() {
	read := s.publishedLocations[:0]
	for _, older := range s.publishedLocations {
		if older.resource.soleHolder() {
			older.resource.drop()
			continue
		}
		read = append(read, older)
	}
	clear(s.publishedLocations[len(read):])
	s.publishedLocations = read
}

func (s *storeMemory) growLocations(bytes uintptr) error {
	if err := s.tables.locations.growTo(bytes); err != nil {
		return err
	}
	s.forgetUnreadLocations()
	for _, older := range s.publishedLocations {
		if err := older.growTo(bytes); err != nil {
			return err
		}
	}
	return nil
}

func (s *storeMemory) dropPublishedLocations() {
	for _, older := range s.publishedLocations {
		older.resource.drop()
	}
	s.publishedLocations = nil
}
