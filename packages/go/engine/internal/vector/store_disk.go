package vector

import (
	"bytes"
	"unsafe"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
)

func mapFile(path string) (*mappedVectorFile, error) {
	mapped, err := core.MapVectorFile(path)
	if err != nil {
		return nil, coreFailure("mapVectorFile", err)
	}
	return &mappedVectorFile{path: path, mapped: mapped, resource: newSharedResource(mapped.Unmap)}, nil
}

func (s *storeMemory) addVectorFile(path string) (int32, error) {
	for index, file := range s.tables.files {
		if file != nil && file.path == path {
			return int32(index), nil
		}
	}
	mapped, err := mapFile(path)
	if err != nil {
		return 0, err
	}
	next := s.tables.clone()
	next.files = append(next.files, mapped)
	s.tables = next
	return int32(len(next.files) - 1), nil
}

func (s *storeMemory) fileHoldsSameBytes(ordinal int32, location diskLocation) bool {
	files := s.tables.files
	if location.fileIndex < 0 || int(location.fileIndex) >= len(files) || files[location.fileIndex] == nil ||
		files[location.fileIndex].mapped == nil {
		return false
	}
	held := s.vectorSlot(s.tables, ordinal)
	if held == nil {
		return false
	}
	content := files[location.fileIndex].mapped.Bytes()
	length := s.dimension * 4
	offset := int(location.offset)
	if offset+length > len(content) {
		return false
	}
	heldBytes := unsafe.Slice((*byte)(unsafe.Pointer(unsafe.SliceData(held))), length)
	return bytes.Equal(content[offset:offset+length], heldBytes)
}

func (s *storeMemory) releaseToFile(ordinal int32, location diskLocation) bool {
	if !s.holdsDocument(ordinal) {
		return false
	}
	if s.vectorFileOf(ordinal) == vectorInMemory && !s.fileHoldsSameBytes(ordinal, location) {
		return false
	}
	s.word(storeWordReleasedVectorsToDisk).Store(1)
	uint32Word(s.vectorOffset.pointer(), int(ordinal)).Store(location.offset)
	int32Word(s.vectorFile.pointer(), int(ordinal)).Store(location.fileIndex)
	return true
}

func (s *storeMemory) ordinalStillHeld(ordinal int32) bool {
	return s.holdsDocument(ordinal) || s.holdsVector(ordinal) || s.keepsFreedVector(ordinal)
}

func (s *storeMemory) blockFullyCold(index int) bool {
	capacity := s.vectorLayout.capacity
	slots := int(s.slots())
	end := min(slots, (index+1)*capacity)
	if end < (index+1)*capacity {
		return false
	}
	for ordinal := index * capacity; ordinal < end; ordinal++ {
		if s.ordinalStillHeld(int32(ordinal)) && s.vectorFileOf(int32(ordinal)) == vectorInMemory {
			return false
		}
	}
	return true
}

func (s *storeMemory) releaseColdBlocks() (*storeTables, []*sharedResource) {
	var next *storeTables
	var dropped []*sharedResource
	for index, block := range s.tables.vectorBlocks {
		if block == nil || !s.blockFullyCold(index) {
			continue
		}
		if next == nil {
			next = s.tables.clone()
		}
		next.vectorBlocks[index] = nil
		dropped = append(dropped, block.resource)
	}
	referenced := map[int32]struct{}{}
	for ordinal := range s.slots() {
		if s.ordinalStillHeld(ordinal) && s.vectorFileOf(ordinal) != vectorInMemory {
			referenced[s.vectorFileOf(ordinal)] = struct{}{}
		}
	}
	for index, file := range s.tables.files {
		if file == nil || file.path == "" {
			continue
		}
		if _, used := referenced[int32(index)]; used {
			continue
		}
		if next == nil {
			next = s.tables.clone()
		}
		next.files[index] = &mappedVectorFile{}
		if file.resource != nil {
			dropped = append(dropped, file.resource)
		}
	}
	return next, dropped
}

func (s *storeMemory) filePaths() []string {
	paths := []string{}
	for _, file := range s.tables.files {
		if file != nil && file.path != "" {
			paths = append(paths, file.path)
		}
	}
	return paths
}

func (s *storeMemory) closedFiles() (*storeTables, []*sharedResource) {
	next := s.tables.clone()
	var dropped []*sharedResource
	for index, file := range next.files {
		if file == nil || file.mapped == nil {
			continue
		}
		next.files[index] = &mappedVectorFile{path: file.path}
		dropped = append(dropped, file.resource)
	}
	return next, dropped
}

func (s *storeMemory) reopenedFiles(rewrite func(path string) string) (*storeTables, []*sharedResource, error) {
	next := s.tables.clone()
	var dropped, opened []*sharedResource
	for index, file := range next.files {
		if file == nil || file.path == "" {
			continue
		}
		path := file.path
		if rewrite != nil {
			path = rewrite(path)
		}
		if file.mapped != nil && path == file.path {
			continue
		}
		mapped, err := mapFile(path)
		if err != nil {
			for _, resource := range opened {
				resource.drop()
			}
			return nil, nil, err
		}
		opened = append(opened, mapped.resource)
		next.files[index] = mapped
		if file.resource != nil {
			dropped = append(dropped, file.resource)
		}
	}
	return next, dropped, nil
}
