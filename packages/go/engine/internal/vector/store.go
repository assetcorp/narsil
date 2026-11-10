package vector

import (
	"sync"
	"sync/atomic"
	"unsafe"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

const (
	storeWordBlockCount              = 2
	storeWordDocIDBytes              = 5
	storeWordCodeBlockCount          = 6
	storeWordReleasedVectorsToDisk   = 8
	storeWordUnplacedCount           = 9
	storeWordRemovedCount            = 10
	storeWordOrdinalLayoutGeneration = 11
	storeHeaderBytes                 = core.StoreHeaderWords * 4
	vectorInMemory                   = int32(core.VectorInABlock)
)

type blockGeometry struct {
	slotsOffset uintptr
	slotStride  uintptr
	capacity    int
}

func vectorBlockGeometry(dimension int, blockBytes uintptr) blockGeometry {
	scratchStride := alignUp(uintptr(dimension) * 4)
	slotsOffset := alignUp(vectorScratchSlots * scratchStride)
	slotStride := alignUp(uintptr(dimension) * 4)
	usable := min(blockBytes, blockMaxBytes)
	capacity := 1
	if usable > slotsOffset {
		capacity = max(1, int((usable-slotsOffset)/slotStride))
	}
	return blockGeometry{slotsOffset: slotsOffset, slotStride: slotStride, capacity: capacity}
}

func codeBytesOf(dimension int, bits uint32) int {
	return (dimension*int(bits) + 7) / 8
}

func stagedQueryBytes(dimension int, bits uint32) int {
	switch bits {
	case 8:
		return dimension
	case 4:
		return codeBytesOf(dimension, 4)
	}
	return 4 * codeBytesOf(dimension, bits)
}

func codeBlockGeometry(dimension int, bits uint32) blockGeometry {
	scratchStride := alignUp(uintptr(stagedQueryBytes(dimension, bits)))
	slotsOffset := alignUp(vectorScratchSlots * scratchStride)
	slotStride := uintptr(core.RecordBytes(uint32(dimension), bits))
	return blockGeometry{slotsOffset: slotsOffset, slotStride: slotStride,
		capacity: int((uintptr(blockMaxBytes) - slotsOffset) / slotStride)}
}

type storeBlock struct {
	memory   *growable
	resource *sharedResource
}

func newStoreBlock(geometry blockGeometry) (*storeBlock, error) {
	initial := geometry.slotsOffset + uintptr(min(vectorBlockInitialSlots, geometry.capacity))*geometry.slotStride
	full := min(uintptr(blockMaxBytes), geometry.slotsOffset+uintptr(geometry.capacity)*geometry.slotStride)
	memory, err := newGrowable(initial, full)
	if err != nil {
		return nil, err
	}
	return &storeBlock{memory: memory, resource: newSharedResource(memory.release)}, nil
}

func (b *storeBlock) slots(geometry blockGeometry) unsafe.Pointer {
	return unsafe.Add(b.memory.pointer(), geometry.slotsOffset)
}

func (b *storeBlock) ensureSlots(geometry blockGeometry, slots int) error {
	return b.memory.growTo(geometry.slotsOffset + uintptr(min(slots, geometry.capacity))*geometry.slotStride)
}

type mappedVectorFile struct {
	path     string
	mapped   *core.VectorFile
	resource *sharedResource
}

type storeMemory struct {
	dimension     int
	bits          uint32
	vectorLayout  blockGeometry
	codeLayout    blockGeometry
	head          *storeHead
	magnitudes    *growable
	present       *growable
	vectorFile    *growable
	vectorOffset  *growable
	born          *growable
	retired       *growable
	slotTable     *Slots
	tables        *storeTables
	table         *ordinalTable
	byDocID       sync.Map
	liveCount     atomic.Int64
	removedCount  atomic.Int64
	unplacedCount atomic.Int64
	retiredScans  atomic.Int64
	replaced      map[int32]struct{}
	scanned       map[int32]struct{}
	freedHolds    int
	freedHeld     map[int32]struct{}
	unknownParts  int
	docIDBytes    int
	longestDocID  int
	resource      *sharedResource
}

func newStoreMemory(dimension int, bits uint32, blockBytes uintptr, slots *Slots) (*storeMemory, error) {
	store := &storeMemory{
		dimension:    dimension,
		bits:         bits,
		vectorLayout: vectorBlockGeometry(dimension, blockBytes),
		slotTable:    slots,
		tables:       &storeTables{},
		table:        newOrdinalTable(),
		replaced:     map[int32]struct{}{},
		scanned:      map[int32]struct{}{},
		freedHeld:    map[int32]struct{}{},
	}
	if bits != 0 {
		store.codeLayout = codeBlockGeometry(dimension, bits)
	}
	head, err := newStoreHead(dimension, vectorStoreInitialCapacity)
	if err != nil {
		return nil, err
	}
	store.head = head
	regions := []struct {
		target  **growable
		initial uintptr
		max     uintptr
	}{
		{&store.magnitudes, vectorStoreInitialCapacity * 8, (MaxVectorOrdinals + 1) * 8},
		{&store.present, vectorStoreInitialCapacity, MaxVectorOrdinals + 1},
		{&store.vectorFile, vectorStoreInitialCapacity * 4, (MaxVectorOrdinals + 1) * 4},
		{&store.vectorOffset, vectorStoreInitialCapacity * 4, (MaxVectorOrdinals + 1) * 4},
		{&store.born, vectorStoreInitialCapacity * 8, (MaxVectorOrdinals + 1) * 8},
		{&store.retired, vectorStoreInitialCapacity * 8, (MaxVectorOrdinals + 1) * 8},
	}
	for _, region := range regions {
		memory, err := newGrowable(region.initial, region.max)
		if err != nil {
			store.releaseRegions()
			head.resource.drop()
			return nil, err
		}
		*region.target = memory
	}
	store.fillInMemory(0)
	store.resource = newSharedResource(store.releaseRegions)
	return store, nil
}

type storeHead struct {
	header      *growable
	centroid    *growable
	codePresent *growable
	resource    *sharedResource
}

func newStoreHead(dimension int, ordinals uintptr) (*storeHead, error) {
	head := &storeHead{}
	regions := []struct {
		target  **growable
		initial uintptr
		max     uintptr
	}{
		{&head.header, storeHeaderBytes, storeHeaderBytes},
		{&head.centroid, uintptr(dimension) * 4, uintptr(dimension) * 4},
		{&head.codePresent, ordinals, MaxVectorOrdinals + 1},
	}
	for _, region := range regions {
		memory, err := newGrowable(region.initial, region.max)
		if err != nil {
			head.release()
			return nil, err
		}
		*region.target = memory
	}
	head.resource = newSharedResource(head.release)
	return head, nil
}

func (h *storeHead) release() {
	for _, region := range []*growable{h.header, h.centroid, h.codePresent} {
		if region != nil {
			region.release()
		}
	}
}

func (s *storeMemory) every() []*growable {
	return []*growable{s.magnitudes, s.present, s.vectorFile, s.vectorOffset, s.born, s.retired}
}

func (s *storeMemory) releaseRegions() {
	for _, region := range s.every() {
		if region != nil {
			region.release()
		}
	}
}

func (s *storeMemory) fillInMemory(fromBytes uintptr) {
	words := int32Values(s.vectorFile.pointer(), int(s.vectorFile.length/4))
	for index := int(fromBytes / 4); index < len(words); index++ {
		words[index] = vectorInMemory
	}
}

func (s *storeMemory) word(index int) *atomic.Int32 {
	return int32Word(s.head.header.pointer(), index)
}

func (s *storeMemory) slots() int32 {
	return s.table.slots.Load()
}

func (s *storeMemory) calibrated() bool {
	return s.word(core.StoreWordCalibrated).Load() == 1
}

func (s *storeMemory) codeCount() int {
	return int(s.word(core.StoreWordCodeCount).Load())
}

func (s *storeMemory) calibrationGeneration() int32 {
	return s.word(core.StoreWordCalibrationGeneration).Load()
}

func (s *storeMemory) centroidValues() []float32 {
	return float32Values(s.head.centroid.pointer(), s.dimension)
}

func (s *storeMemory) magnitude(ordinal int32) float64 {
	return *float64Slot(s.magnitudes.pointer(), int(ordinal))
}

func (s *storeMemory) holdsVector(ordinal int32) bool {
	return ordinal >= 0 && ordinal < s.slots() && loadByte(s.present.pointer(), int(ordinal)) == 1
}

func (s *storeMemory) holdsCode(ordinal int32) bool {
	return ordinal >= 0 && ordinal < s.slots() && loadByte(s.head.codePresent.pointer(), int(ordinal)) == 1
}

func (s *storeMemory) vectorFileOf(ordinal int32) int32 {
	return int32Word(s.vectorFile.pointer(), int(ordinal)).Load()
}

func (s *storeMemory) isCold(ordinal int32) bool {
	return ordinal >= 0 && ordinal < s.slots() && s.vectorFileOf(ordinal) != vectorInMemory
}

func (s *storeMemory) ordinalOf(docID string) (int32, bool) {
	value, ok := s.byDocID.Load(docID)
	if !ok {
		return 0, false
	}
	ordinal, ok := value.(int32)
	return ordinal, ok
}

func (s *storeMemory) docIDOf(ordinal int32) (string, bool) {
	return s.table.docID(ordinal)
}

func (s *storeMemory) holdsDocument(ordinal int32) bool {
	return ordinal >= 0 && ordinal < s.slots() && s.table.flags(ordinal)&ordinalHoldsDocument != 0
}

func (s *storeMemory) has(docID string) bool {
	_, held := s.ordinalOf(docID)
	return held
}

func (s *storeMemory) size() int {
	return int(s.liveCount.Load())
}

func (s *storeMemory) discard() {
	dropBlocks(s.tables.vectorBlocks)
	dropBlocks(s.tables.codeBlocks)
	for _, file := range s.tables.files {
		if file != nil && file.resource != nil {
			file.resource.drop()
		}
	}
	s.head.resource.drop()
	s.resource.drop()
}

type storeTables struct {
	vectorBlocks []*storeBlock
	codeBlocks   []*storeBlock
	files        []*mappedVectorFile
}

func (t *storeTables) clone() *storeTables {
	return &storeTables{
		vectorBlocks: append([]*storeBlock(nil), t.vectorBlocks...),
		codeBlocks:   append([]*storeBlock(nil), t.codeBlocks...),
		files:        append([]*mappedVectorFile(nil), t.files...),
	}
}

func (t *storeTables) resources() []*sharedResource {
	var held []*sharedResource
	for _, block := range t.vectorBlocks {
		if block != nil {
			held = append(held, block.resource)
		}
	}
	for _, block := range t.codeBlocks {
		held = append(held, block.resource)
	}
	for _, file := range t.files {
		if file != nil && file.resource != nil {
			held = append(held, file.resource)
		}
	}
	return held
}

func (s *storeMemory) vectorSlot(tables *storeTables, ordinal int32) []float32 {
	index := int(ordinal) / s.vectorLayout.capacity
	if ordinal < 0 || index >= len(tables.vectorBlocks) || tables.vectorBlocks[index] == nil {
		return nil
	}
	local := uintptr(int(ordinal) % s.vectorLayout.capacity)
	base := unsafe.Add(tables.vectorBlocks[index].slots(s.vectorLayout), local*s.vectorLayout.slotStride)
	return float32Values(base, s.dimension)
}

func (s *storeMemory) recordSlot(tables *storeTables, ordinal int32) []byte {
	if s.bits == 0 || ordinal < 0 {
		return nil
	}
	index := int(ordinal) / s.codeLayout.capacity
	if index >= len(tables.codeBlocks) {
		return nil
	}
	local := uintptr(int(ordinal) % s.codeLayout.capacity)
	base := unsafe.Add(tables.codeBlocks[index].slots(s.codeLayout), local*s.codeLayout.slotStride)
	return bytesAt(base, s.codeLayout.slotStride)
}

func capacityExceeded(ordinal int32) error {
	return narsilerr.New(narsilerr.CodePartitionCapacityExceeded,
		"A vector field holds at most 16777216 vectors, deleted ones included, until it is rebuilt",
		map[string]any{"ordinal": float64(ordinal), "maxOrdinals": float64(MaxVectorOrdinals)})
}
