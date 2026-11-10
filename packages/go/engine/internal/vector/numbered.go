package vector

import (
	"context"
	"encoding/binary"
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/vector/payload"
)

const (
	noNumber        = -1
	noOrdinalNumber = -1
)

func (g *graphMemory) maxConnections(layer int) int {
	if layer == 0 {
		return g.shape.mMax0
	}
	return g.shape.m
}

func (g *graphMemory) layerList(ordinal int32, layer int) ([]int32, int, bool) {
	level := int(g.nodeLevel(ordinal))
	if level < 0 || layer > level {
		return nil, 0, false
	}
	if layer == 0 {
		words := int32Values(g.level0.pointer(), int(g.level0.length/4))
		start := int(ordinal) * g.level0Stride
		if start+g.level0Stride > len(words) {
			return nil, 0, false
		}
		return words, start, true
	}
	base := int(int32Word(g.upperBase.pointer(), int(ordinal)).Load())
	if base == 0 {
		return nil, 0, false
	}
	words := int32Values(g.upper.pointer(), int(g.upper.length/4))
	start := base - 1 + (layer-1)*g.upperStride
	if start < 0 || start+g.upperStride > len(words) {
		return nil, 0, false
	}
	return words, start, true
}

func (g *graphMemory) savedTopLayer(ordinal int32) int {
	if ordinal < 0 || ordinal >= g.slots() {
		return -1
	}
	return min(int(g.nodeLevel(ordinal)), maxLayerCap)
}

func (g *graphMemory) serializePart(numberOfOrdinal, ordinalOfNumber []int32, topLayers []int8, start, end int) payload.NumberedGraph {
	levels := make([]byte, end-start)
	values := make([]byte, 0, (end-start)*g.level0Stride*4)
	for number := start; number < end; number++ {
		top := int(topLayers[number])
		levels[number-start] = byte(top + 1)
		for layer := 0; layer <= top; layer++ {
			words, base, held := g.layerList(ordinalOfNumber[number], layer)
			count := 0
			if held {
				count = max(0, min(int(words[base]), g.maxConnections(layer)))
			}
			countAt := len(values)
			values = binary.LittleEndian.AppendUint32(values, 0)
			written := 0
			for index := 1; index <= count; index++ {
				neighbourOrdinal := words[base+index]
				if neighbourOrdinal < 0 || int(neighbourOrdinal) >= len(numberOfOrdinal) {
					continue
				}
				neighbour := numberOfOrdinal[neighbourOrdinal]
				if neighbour == noNumber || int(neighbour) == number || int(topLayers[neighbour]) < layer {
					continue
				}
				values = binary.LittleEndian.AppendUint32(values, uint32(neighbour))
				written++
			}
			binary.LittleEndian.PutUint32(values[countAt:], uint32(written))
		}
	}
	return payload.NumberedGraph{Levels: levels, Neighbours: values}
}

func (g *graphMemory) serializeNumbered(ctx context.Context, numberOfOrdinal, ordinalOfNumber []int32,
	partSize int) ([]payload.NumberedGraph, error) {
	topLayers := make([]int8, len(ordinalOfNumber))
	for number, ordinal := range ordinalOfNumber {
		topLayers[number] = int8(g.savedTopLayer(ordinal))
	}
	entryOrdinal := g.entryPoint()
	entryNumber := int32(noNumber)
	if entryOrdinal >= 0 && int(entryOrdinal) < len(numberOfOrdinal) {
		entryNumber = numberOfOrdinal[entryOrdinal]
	}
	header := payload.NumberedGraph{
		MaxLayer:       uint8(max(0, min(int(g.word(core.GraphWordTopLayer).Load()), maxLayerCap))),
		M:              g.shape.m,
		EfConstruction: g.shape.efConstruction,
		Metric:         metricName(g.shape.metric),
	}
	if entryNumber != noNumber && topLayers[entryNumber] >= 0 {
		header.EntryPoint = model.Some(uint32(entryNumber))
	}
	parts := []payload.NumberedGraph{}
	for start := 0; start < len(ordinalOfNumber); start += partSize {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		part := g.serializePart(numberOfOrdinal, ordinalOfNumber, topLayers, start, min(start+partSize, len(ordinalOfNumber)))
		joined := header
		joined.Levels, joined.Neighbours = part.Levels, part.Neighbours
		parts = append(parts, joined)
	}
	return parts, nil
}

func metricName(metric core.Metric) model.VectorMetric {
	switch metric {
	case core.MetricDotProduct:
		return model.MetricDotProduct
	case core.MetricEuclidean:
		return model.MetricEuclidean
	}
	return model.MetricCosine
}

func (g *graphMemory) createNode(ordinal int32, top int) error {
	if err := g.ensureCapacity(int(ordinal) + 1); err != nil {
		return err
	}
	base := int32(0)
	if top >= 1 {
		if err := g.ensureUpperRoom(int32(top)); err != nil {
			return err
		}
		used := g.word(core.GraphWordUpperUsed)
		base = used.Load() + 1
		used.Add(int32(top * g.upperStride))
	}
	int32Word(g.upperBase.pointer(), int(ordinal)).Store(base)
	int32Word(g.level0.pointer(), int(ordinal)*g.level0Stride).Store(0)
	raiseWord(g.word(core.GraphWordSlots), ordinal+1)
	storeByte(g.nearestLinkDue.pointer(), int(ordinal), 1)
	storeByte(g.nodeLevels.pointer(), int(ordinal), byte(top+1))
	return nil
}

func (g *graphMemory) writeNeighbours(ordinal int32, layer int, neighbours []int32) {
	words, base, held := g.layerList(ordinal, layer)
	if !held {
		return
	}
	stride := g.upperStride
	if layer == 0 {
		stride = g.level0Stride
	}
	limit := min(len(neighbours), stride-1)
	copy(words[base+1:base+1+limit], neighbours[:limit])
	words[base] = int32(limit)
}

func highestNodeOrdinal(graph payload.NumberedGraphParts, ordinalAt func(int) int32) int32 {
	highest := int32(-1)
	for index, part := range graph.Parts {
		for at, level := range part.Levels {
			if ordinal := ordinalAt(index*graph.PartSize + at); level > 0 && ordinal > highest {
				highest = ordinal
			}
		}
	}
	return highest
}

type loadedNodes struct {
	highestLayer int
	onHighest    int32
	kept         []int32
}

func (g *graphMemory) loadPart(graph payload.NumberedGraphParts, index int, ordinalAt func(int) int32, nodes *loadedNodes) error {
	part := graph.Parts[index]
	cursor := 0
	for at, level := range part.Levels {
		number := index*graph.PartSize + at
		top := int(level) - 1
		if top < 0 {
			continue
		}
		ordinal := ordinalAt(number)
		keptTop := min(top, maxLayerCap)
		if ordinal != noOrdinalNumber {
			if err := g.createNode(ordinal, keptTop); err != nil {
				return err
			}
			g.word(core.GraphWordNodeCount).Add(1)
			if keptTop > nodes.highestLayer {
				nodes.highestLayer, nodes.onHighest = keptTop, ordinal
			}
		}
		for layer := 0; layer <= top; layer++ {
			count := int(payload.NeighbourValue(part.Neighbours, cursor))
			nodes.kept = nodes.kept[:0]
			limit := g.maxConnections(layer)
			for offset := 1; offset <= count && len(nodes.kept) < limit; offset++ {
				neighbour := int(payload.NeighbourValue(part.Neighbours, cursor+offset))
				neighbourOrdinal := ordinalAt(neighbour)
				if neighbourOrdinal == noOrdinalNumber || neighbour == number || graph.TopLayer(neighbour) < layer {
					continue
				}
				if !slices.Contains(nodes.kept, neighbourOrdinal) {
					nodes.kept = append(nodes.kept, neighbourOrdinal)
				}
			}
			cursor += count + 1
			if ordinal != noOrdinalNumber && layer <= keptTop {
				g.writeNeighbours(ordinal, layer, nodes.kept)
			}
		}
	}
	return nil
}

func (g *graphMemory) deserializeNumbered(graph payload.NumberedGraphParts, ordinalOfNumber []int32) error {
	for _, part := range graph.Parts {
		if err := payload.RequireWholeNeighbourLists(part); err != nil {
			return err
		}
	}
	ordinalAt := func(number int) int32 {
		if number < 0 || number >= len(ordinalOfNumber) {
			return noOrdinalNumber
		}
		return ordinalOfNumber[number]
	}
	if highest := highestNodeOrdinal(graph, ordinalAt); highest >= 0 {
		if err := g.ensureCapacity(int(highest) + 1); err != nil {
			return err
		}
	}
	nodes := &loadedNodes{highestLayer: -1, onHighest: noOrdinalNumber}
	for index := range graph.Parts {
		if err := g.loadPart(graph, index, ordinalAt, nodes); err != nil {
			return err
		}
	}
	entryOrdinal, entryTop := int32(noOrdinalNumber), -1
	if len(graph.Parts) > 0 {
		if entry, set := graph.Parts[0].EntryPoint.Get(); set {
			entryOrdinal = ordinalAt(int(entry))
			entryTop = min(graph.TopLayer(int(entry)), maxLayerCap)
		}
	}
	if entryOrdinal != noOrdinalNumber && entryTop >= 0 {
		g.word(core.GraphWordEntryPoint).Store(entryOrdinal)
		g.word(core.GraphWordTopLayer).Store(int32(entryTop))
	} else {
		g.word(core.GraphWordEntryPoint).Store(nodes.onHighest)
		g.word(core.GraphWordTopLayer).Store(int32(nodes.highestLayer))
	}
	g.word(core.GraphWordUnlinkedNodes).Store(0)
	g.word(graphWordIncomingUncounted).Store(1)
	return nil
}
