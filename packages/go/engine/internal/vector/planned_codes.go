package vector

import (
	"unsafe"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/vector/payload"
)

type plannedCodeStore struct {
	block        *core.Block
	native       *core.Store
	header       unsafe.Pointer
	present      unsafe.Pointer
	vectors      unsafe.Pointer
	records      unsafe.Pointer
	vectorStride uintptr
	recordBytes  uintptr
	slots        int
}

func newPlannedCodeStore(dimension int, bits uint32, centroid []float64, slots int) (*plannedCodeStore, error) {
	vectorStride := alignUp(uintptr(dimension) * 4)
	recordBytes := uintptr(core.RecordBytes(uint32(dimension), bits))
	headerAt := uintptr(0)
	centroidAt := alignUp(headerAt + storeHeaderBytes)
	codePresentAt := alignUp(centroidAt + uintptr(dimension)*4)
	magnitudesAt := alignUp(codePresentAt + uintptr(slots))
	presentAt := alignUp(magnitudesAt + uintptr(slots)*8)
	vectorsAt := alignUp(presentAt + uintptr(slots))
	recordsAt := alignUp(vectorsAt + uintptr(slots)*vectorStride)
	total := recordsAt + uintptr(slots)*recordBytes
	block, err := core.AllocateBlock(total)
	if err != nil {
		return nil, regionFailure(err, total, total)
	}
	base := block.Pointer()
	planned := &plannedCodeStore{
		block:        block,
		header:       unsafe.Add(base, headerAt),
		present:      unsafe.Add(base, presentAt),
		vectors:      unsafe.Add(base, vectorsAt),
		records:      unsafe.Add(base, recordsAt),
		vectorStride: vectorStride,
		recordBytes:  recordBytes,
		slots:        slots,
	}
	values := float32Values(unsafe.Add(base, centroidAt), dimension)
	for index, component := range centroid {
		values[index] = float32(component)
	}
	int32Word(planned.header, core.StoreWordCalibrated).Store(1)
	native, err := core.NewStore(core.StoreLayout{
		Header:             planned.header,
		Dimension:          uint32(dimension),
		Bits:               bits,
		CodeBlocks:         []unsafe.Pointer{planned.records},
		RecordsPerBlock:    uint32(slots),
		CodePresent:        unsafe.Add(base, codePresentAt),
		Centroid:           unsafe.Add(base, centroidAt),
		VectorBlocks:       []unsafe.Pointer{planned.vectors},
		VectorsPerBlock:    uint32(slots),
		VectorStrideFloats: uint32(vectorStride / 4),
		Magnitudes:         unsafe.Add(base, magnitudesAt),
		Present:            planned.present,
	})
	if err != nil {
		block.Free()
		return nil, coreFailure("attachStore", err)
	}
	planned.native = native
	return planned, nil
}

func (p *plannedCodeStore) release() {
	p.native.Retire()
	p.block.Free()
}

func (p *plannedCodeStore) place(slot int, vector []float32) {
	copy(float32Values(unsafe.Add(p.vectors, uintptr(slot)*p.vectorStride), len(vector)), vector)
	storeByte(p.present, slot, 1)
}

func (p *plannedCodeStore) record(slot int) []byte {
	return bytesAt(unsafe.Add(p.records, uintptr(slot)*p.recordBytes), p.recordBytes)
}

func (f *Field) codesAgainstCentroid(centroid []float64, vectors []float32, ordinals []int32) (*payload.Codes, error) {
	dimension := f.config.dimension
	stride := core.RecordBytes(uint32(dimension), f.config.bits)
	records := make([]byte, len(ordinals)*int(stride))
	slots := min(len(ordinals), recalibrationChunkVectors)
	codes := &payload.Codes{Bits: uint8(f.config.bits), Centroid: centroid, Records: records}
	if slots == 0 {
		return codes, nil
	}
	planned, err := newPlannedCodeStore(dimension, f.config.bits, centroid, slots)
	if err != nil {
		return nil, err
	}
	defer planned.release()
	positions := make([]int, 0, slots)
	local := make([]int32, 0, slots)
	flush := func(workspace *core.Workspace) error {
		if len(positions) == 0 {
			return nil
		}
		int32Word(planned.header, core.StoreWordSlots).Store(int32(len(positions)))
		if err := workspace.Quantise(planned.native, f.config.nativeMetric, local); err != nil {
			return coreFailure("quantise", err)
		}
		for slot, position := range positions {
			copy(records[position*int(stride):], planned.record(slot))
		}
		positions, local = positions[:0], local[:0]
		return nil
	}
	err = withWorkspace(func(workspace *core.Workspace) error {
		for position, ordinal := range ordinals {
			if ordinal == noLiveVectorAtPosition {
				continue
			}
			slot := len(positions)
			planned.place(slot, vectors[position*dimension:(position+1)*dimension])
			positions = append(positions, position)
			local = append(local, int32(slot))
			if len(positions) == slots {
				if err := flush(workspace); err != nil {
					return err
				}
			}
		}
		return flush(workspace)
	})
	if err != nil {
		return nil, err
	}
	return codes, nil
}
