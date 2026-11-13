package vector

import (
	"encoding/binary"
	"math"
	"strconv"
	"unsafe"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
)

const coldScoreBornSequence int64 = 1

type coldScoreStore struct {
	block       *core.Block
	native      *core.Store
	magnitudes  unsafe.Pointer
	present     unsafe.Pointer
	vectorFile  unsafe.Pointer
	vectorStart unsafe.Pointer
	born        unsafe.Pointer
}

func newColdScoreStore(dimension int, count int, files []*core.VectorFile) (*coldScoreStore, error) {
	headerAt := uintptr(0)
	centroidAt := alignUp(headerAt + storeHeaderBytes)
	codePresentAt := alignUp(centroidAt + uintptr(dimension)*4)
	magnitudesAt := alignUp(codePresentAt + uintptr(count))
	presentAt := alignUp(magnitudesAt + uintptr(count)*8)
	vectorFileAt := alignUp(presentAt + uintptr(count))
	vectorStartAt := alignUp(vectorFileAt + uintptr(count)*4)
	bornAt := alignUp(vectorStartAt + uintptr(count)*4)
	retiredAt := bornAt + uintptr(count)*8
	total := retiredAt + uintptr(count)*8
	block, err := core.AllocateBlock(total)
	if err != nil {
		return nil, regionFailure(err, total, total)
	}
	base := block.Pointer()
	scores := &coldScoreStore{block: block, magnitudes: unsafe.Add(base, magnitudesAt),
		present: unsafe.Add(base, presentAt), vectorFile: unsafe.Add(base, vectorFileAt),
		vectorStart: unsafe.Add(base, vectorStartAt), born: unsafe.Add(base, bornAt)}
	int32Word(unsafe.Add(base, headerAt), core.StoreWordSlots).Store(int32(count))
	native, err := core.NewStore(core.StoreLayout{
		Header:             unsafe.Add(base, headerAt),
		Dimension:          uint32(dimension),
		VectorStrideFloats: uint32(dimension),
		CodePresent:        unsafe.Add(base, codePresentAt),
		Centroid:           unsafe.Add(base, centroidAt),
		Magnitudes:         scores.magnitudes,
		Present:            scores.present,
		VectorFile:         scores.vectorFile,
		VectorOffset:       scores.vectorStart,
		Files:              files,
		BornAt:             unsafe.Add(base, bornAt),
		RetiredAt:          unsafe.Add(base, retiredAt),
	})
	if err != nil {
		block.Free()
		return nil, coreFailure("attachStore", err)
	}
	scores.native = native
	return scores, nil
}

func (s *coldScoreStore) release() {
	s.native.Free()
	s.block.Free()
}

func (s *coldScoreStore) place(slot int, file int, start uint32, magnitude float64) {
	*float64Slot(s.magnitudes, slot) = magnitude
	int32Word(s.vectorFile, slot).Store(int32(file))
	uint32Word(s.vectorStart, slot).Store(start)
	*(*int64)(unsafe.Add(s.born, uintptr(slot)*8)) = coldScoreBornSequence
	storeByte(s.present, slot, 1)
}

func (c *coldGraphField) locate(number int) (int, uint32, float64, error) {
	at := c.fileOfNumber(number)
	file := c.input.Files[at]
	position := int64(number - c.firstNumbers[at])
	start := int64(file.VectorPages.Offset) + position*int64(c.input.Dimension)*coldVectorComponentBytes
	if start < 0 || start > math.MaxUint32 {
		return 0, 0, 0, coldReadFailed(`Vector `+strconv.Itoa(number)+` of "`+file.Key+`" lies beyond the mapped range`,
			file.Key)
	}
	var magnitude [coldMagnitudeBytes]byte
	if err := file.Magnitudes.Read(position*coldMagnitudeBytes, magnitude[:]); err != nil {
		return 0, 0, 0, err
	}
	return at, uint32(start), math.Float64frombits(binary.LittleEndian.Uint64(magnitude[:])), nil
}

func (c *coldGraphField) ScoreNumbers(query []float32, metric core.Metric, numbers []int, distances []float64) error {
	if len(numbers) == 0 {
		return nil
	}
	mapping, err := c.acquireMapping()
	if err != nil {
		return err
	}
	defer mapping.done()
	scores, err := newColdScoreStore(c.input.Dimension, len(numbers), mapping.files)
	if err != nil {
		return err
	}
	defer scores.release()
	ordinals := make([]int32, len(numbers))
	for slot, number := range numbers {
		file, start, magnitude, err := c.locate(number)
		if err != nil {
			return err
		}
		scores.place(slot, file, start, magnitude)
		ordinals[slot] = int32(slot)
	}
	return withWorkspace(func(workspace *core.Workspace) error {
		if err := workspace.Score(scores.native, query, metric, coldScoreBornSequence, ordinals, distances); err != nil {
			return coreFailure("score", err)
		}
		return nil
	})
}
