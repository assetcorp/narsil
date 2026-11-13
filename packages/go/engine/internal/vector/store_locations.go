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
