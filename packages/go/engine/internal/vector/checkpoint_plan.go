package vector

import (
	"context"
	"math"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
	"github.com/assetcorp/narsil/packages/go/engine/internal/vector/payload"
)

const ordinalHoldsNoNumber int32 = -1

type savedVectorFile struct {
	id             uint64
	key            string
	ordinals       []int32
	calibration    int32
	hasCalibration bool
}

type fieldSignature struct {
	revision       int64
	graphSize      int
	calibration    int32
	hasCalibration bool
}

type KeptVectorFile struct {
	ID    uint64
	Key   string
	Count int
	Dead  []byte
}

type WrittenVectorFile struct {
	ID       uint64
	Key      string
	Ordinals []int32
}

func VectorsPerFile(dimension int, bits uint32) int {
	recordBytes := 0
	if bits != 0 {
		recordBytes = payload.RecordBytes(dimension, uint8(bits))
	}
	docIDBytes := vectorFileStringHeaderBytes + schema.MaxDocIDLength*3
	perVector := dimension*4 + recordBytes + docIDBytes
	overhead := vectorFileFixedOverheadBytes + dimension*vectorFileCentroidBytesPerDim
	fitting := (envelope.MaxFileBytes - overhead) / perVector
	return max(1, min(vectorFileMaxVectors, fitting))
}

func (f *Field) codedCentroid() []float64 {
	if !f.calibrated() || f.graph == nil {
		return nil
	}
	values := f.store.centroidValues()
	centroid := make([]float64, len(values))
	for index, value := range values {
		centroid[index] = float64(value)
	}
	return centroid
}

func (f *Field) signature() fieldSignature {
	signature := fieldSignature{revision: f.revision.Load(), graphSize: -1}
	if f.graph != nil {
		signature.graphSize = f.graph.size()
	}
	if f.codedCentroid() != nil {
		signature.calibration, signature.hasCalibration = f.store.calibrationGeneration(), true
	}
	return signature
}

func sameSignature(a *fieldSignature, b fieldSignature) bool {
	return a != nil && *a == b
}

func (f *Field) registryMatches(listedKeys []string) bool {
	if len(listedKeys) != len(f.savedFiles) {
		return false
	}
	for index, file := range f.savedFiles {
		if file.key != listedKeys[index] {
			return false
		}
	}
	return true
}

func (f *Field) isLive(ordinal int32) bool {
	if ordinal == noLiveVectorAtPosition {
		return false
	}
	docID, held := f.store.docIDOf(ordinal)
	return held && !f.tombstones.has(docID)
}

func (f *Field) isGraphTombstone(ordinal int32) bool {
	return ordinal != noLiveVectorAtPosition && f.graph != nil && f.graph.holdsTombstone(ordinal)
}

func (f *Field) isCarried(ordinal int32) bool {
	return f.isLive(ordinal) || f.isGraphTombstone(ordinal)
}

func (f *Field) carriedCountOf(file savedVectorFile) int {
	carried := 0
	for _, ordinal := range file.ordinals {
		if f.isCarried(ordinal) {
			carried++
		}
	}
	return carried
}

func deadBitsWhere(count int, isDeadAt func(position int) bool) []byte {
	var dead []byte
	for position := range count {
		if !isDeadAt(position) {
			continue
		}
		if dead == nil {
			dead = make([]byte, (count+7)/8)
		}
		dead[position>>3] |= 1 << (position & 7)
	}
	return dead
}

func (f *Field) filesWorthKeeping(listed []savedVectorFile, signature fieldSignature) ([]savedVectorFile, []int) {
	kept := []savedVectorFile{}
	carriedCounts := []int{}
	for _, file := range listed {
		carried := f.carriedCountOf(file)
		deadShare := 1.0
		if len(file.ordinals) > 0 {
			deadShare = 1 - float64(carried)/float64(len(file.ordinals))
		}
		sameCalibration := file.hasCalibration == signature.hasCalibration &&
			(!file.hasCalibration || file.calibration == signature.calibration)
		if !sameCalibration || deadShare > vectorFileReplacedAboveDead {
			continue
		}
		kept = append(kept, file)
		carriedCounts = append(carriedCounts, carried)
	}
	return kept, carriedCounts
}

func absorbSmallerPartialFiles(kept []savedVectorFile, carriedCounts []int, vectorsToWrite int, capacity int) ([]savedVectorFile, []int) {
	pending := vectorsToWrite
	for index := len(kept) - 1; index >= 0 && pending > 0; index-- {
		if len(kept[index].ordinals) >= capacity {
			continue
		}
		if carriedCounts[index] > pending {
			break
		}
		pending += carriedCounts[index]
		kept = append(kept[:index], kept[index+1:]...)
		carriedCounts = append(carriedCounts[:index], carriedCounts[index+1:]...)
	}
	return kept, carriedCounts
}

func (f *Field) ordinalsOutsideOf(kept []savedVectorFile) []int32 {
	slots := f.store.slots()
	saved := make([]bool, slots)
	for _, file := range kept {
		for _, ordinal := range file.ordinals {
			if ordinal != noLiveVectorAtPosition && ordinal < slots {
				saved[ordinal] = true
			}
		}
	}
	outside := []int32{}
	for ordinal := range slots {
		if !saved[ordinal] && f.isCarried(ordinal) {
			outside = append(outside, ordinal)
		}
	}
	return outside
}

func (f *Field) countOutside(carriedCounts []int) int {
	held := 0
	for _, carried := range carriedCounts {
		held += carried
	}
	tombstonedNodes := 0
	if f.graph != nil {
		tombstonedNodes = f.graph.tombstoneCount()
	}
	return max(0, f.store.size()-f.tombstones.size()+tombstonedNodes-held)
}

func (f *Field) numberEveryVector(kept []savedVectorFile, written []int32) ([]int32, []int32) {
	total := len(written)
	for _, file := range kept {
		total += len(file.ordinals)
	}
	numberOfOrdinal := make([]int32, f.store.slots())
	for index := range numberOfOrdinal {
		numberOfOrdinal[index] = ordinalHoldsNoNumber
	}
	ordinalOfNumber := make([]int32, total)
	for index := range ordinalOfNumber {
		ordinalOfNumber[index] = noLiveVectorAtPosition
	}
	number := 0
	for _, file := range kept {
		for _, ordinal := range file.ordinals {
			if f.isCarried(ordinal) {
				numberOfOrdinal[ordinal] = int32(number)
				ordinalOfNumber[number] = ordinal
			}
			number++
		}
	}
	for _, ordinal := range written {
		numberOfOrdinal[ordinal] = int32(number)
		ordinalOfNumber[number] = ordinal
		number++
	}
	return numberOfOrdinal, ordinalOfNumber
}

func (f *Field) withBuildHistory(graph payload.NumberedGraph) payload.NumberedGraph {
	if !f.hasShuffledBuild {
		return graph
	}
	graph.ShuffledBuildCount = model.Some(uint32(f.shuffledBuildCount))
	if f.calibration.meanLengthKnown && !math.IsNaN(f.calibration.meanLength) {
		graph.CalibratedMeanLength = model.Some(f.calibration.meanLength)
	}
	return graph
}

func (f *Field) graphPartsOf(ctx context.Context, numberOfOrdinal, ordinalOfNumber []int32) ([]payload.GraphPart, error) {
	if f.graph == nil || len(ordinalOfNumber) == 0 {
		return nil, nil
	}
	graphs, err := f.graph.serializeNumbered(ctx, numberOfOrdinal, ordinalOfNumber, vectorGraphPartVectors)
	if err != nil {
		return nil, err
	}
	parts := make([]payload.GraphPart, len(graphs))
	for index, graph := range graphs {
		parts[index] = payload.GraphPart{FieldName: f.config.fieldName, Graphs: []payload.NumberedGraph{f.withBuildHistory(graph)}}
	}
	return parts, nil
}

func (f *Field) storeHoldsCodeOf(ordinal int32) bool {
	return f.quantises() && f.store.holdsCode(ordinal) && core.RecordBytes(uint32(f.config.dimension), f.config.bits) > 0
}
