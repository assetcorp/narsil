package vector

import (
	"math"
	"sync/atomic"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
)

const (
	graphWordMetric            = 5
	graphWordRetired           = 6
	graphWordIncomingUncounted = 35
	graphHeaderBytes           = core.GraphHeaderWords * 4
	graphLockHeldAlone         = -1
	noEntryPoint               = -1
	upperWordsAddressable      = math.MaxInt32
)

type graphShape struct {
	m              int
	mMax0          int
	efConstruction int
	metric         core.Metric
}

type graphMemory struct {
	shape          graphShape
	level0Stride   int
	upperStride    int
	multiplier     float64
	header         *growable
	nodeLevels     *growable
	level0         *growable
	upperBase      *growable
	upper          *growable
	locks          *growable
	tombstones     *growable
	incoming       *growable
	nearestLinkDue *growable
	slotTable      *Slots
	native         *core.Graph
	resource       *sharedResource
	lineage        *graphLineage
}

type graphLineage struct {
	alsoScan atomic.Pointer[[]int32]
}

func perOrdinalMax(bytesPerOrdinal int) uintptr {
	return uintptr(MaxVectorOrdinals) * uintptr(bytesPerOrdinal)
}

func newGraphMemory(shape graphShape, slots *Slots) (*graphMemory, error) {
	graph := &graphMemory{
		shape:        shape,
		level0Stride: shape.mMax0 + core.ListWordsOverNeighbours,
		upperStride:  shape.m + core.ListWordsOverNeighbours,
		multiplier:   levelMultiplier(shape.m),
		lineage:      &graphLineage{},
		slotTable:    slots.Retain(),
	}
	regions := []struct {
		target  **growable
		initial uintptr
		max     uintptr
	}{
		{&graph.header, graphHeaderBytes, graphHeaderBytes},
		{&graph.nodeLevels, vectorStoreInitialCapacity, perOrdinalMax(1)},
		{&graph.level0, uintptr(vectorStoreInitialCapacity * graph.level0Stride * 4), perOrdinalMax(graph.level0Stride * 4)},
		{&graph.upperBase, vectorStoreInitialCapacity * 4, perOrdinalMax(4)},
		{&graph.upper, uintptr(initialUpperSlots * graph.upperStride * 4), min(perOrdinalMax(graph.upperStride*4), upperWordsAddressable*4)},
		{&graph.locks, vectorStoreInitialCapacity * 4, perOrdinalMax(4)},
		{&graph.tombstones, vectorStoreInitialCapacity, perOrdinalMax(1)},
		{&graph.incoming, vectorStoreInitialCapacity * 4, perOrdinalMax(4)},
		{&graph.nearestLinkDue, vectorStoreInitialCapacity, perOrdinalMax(1)},
	}
	for _, region := range regions {
		memory, err := newGrowable(region.initial, region.max)
		if err != nil {
			graph.free()
			return nil, err
		}
		*region.target = memory
	}
	graph.word(core.GraphWordEntryPoint).Store(noEntryPoint)
	graph.word(core.GraphWordTopLayer).Store(-1)
	graph.word(core.GraphWordM).Store(int32(shape.m))
	graph.word(core.GraphWordMMax0).Store(int32(shape.mMax0))
	graph.word(core.GraphWordEfConstruction).Store(int32(shape.efConstruction))
	graph.word(graphWordMetric).Store(int32(shape.metric))
	native, err := core.NewGraph(graph.regions())
	if err != nil {
		graph.free()
		return nil, coreFailure("attachGraph", err)
	}
	graph.native = native
	graph.publishCapacity()
	graph.resource = newSharedResource(graph.free)
	return graph, nil
}

func (g *graphMemory) regions() core.GraphRegions {
	return core.GraphRegions{
		Header:         g.header.pointer(),
		NodeLevels:     g.nodeLevels.pointer(),
		Level0:         g.level0.pointer(),
		UpperBase:      g.upperBase.pointer(),
		Upper:          g.upper.pointer(),
		Locks:          g.locks.pointer(),
		Tombstones:     g.tombstones.pointer(),
		Incoming:       g.incoming.pointer(),
		NearestLinkDue: g.nearestLinkDue.pointer(),
		HeldLocks:      g.slotTable.heldLocks.Pointer(),
		ThreadSlots:    threadSlotCapacity,
	}
}

func (g *graphMemory) every() []*growable {
	return []*growable{g.header, g.nodeLevels, g.level0, g.upperBase, g.upper, g.locks, g.tombstones,
		g.incoming, g.nearestLinkDue}
}

func (g *graphMemory) releaseRegions() {
	for _, region := range g.every() {
		if region != nil {
			region.release()
		}
	}
}

func (g *graphMemory) free() {
	if g.native != nil {
		g.native.Free()
		g.native = nil
	}
	g.releaseRegions()
	if g.slotTable != nil {
		g.slotTable.resource.drop()
		g.slotTable = nil
	}
}

func (g *graphMemory) word(index int) *atomic.Int32 {
	return int32Word(g.header.pointer(), index)
}

func raiseWord(word *atomic.Int32, value int32) {
	for {
		seen := word.Load()
		if seen >= value || word.CompareAndSwap(seen, value) {
			return
		}
	}
}

func (g *graphMemory) slotCapacity() int {
	return min(int(g.nodeLevels.length), int(g.level0.length)/(g.level0Stride*4), int(g.upperBase.length/4),
		int(g.locks.length/4), int(g.tombstones.length), int(g.incoming.length/4), int(g.nearestLinkDue.length))
}

func (g *graphMemory) publishCapacity() {
	raiseWord(g.word(core.GraphWordSlotCapacity), int32(g.slotCapacity()))
	raiseWord(g.word(core.GraphWordUpperCapacity), int32(g.upper.length/4))
}

func (g *graphMemory) ensureCapacity(needed int) error {
	if needed <= int(g.nodeLevels.length) {
		return nil
	}
	capacity := uintptr(max(needed, min(int(g.nodeLevels.length)*2, int(g.nodeLevels.maxBytes))))
	growths := []struct {
		region *growable
		bytes  uintptr
	}{
		{g.level0, capacity * uintptr(g.level0Stride*4)},
		{g.upperBase, capacity * 4},
		{g.locks, capacity * 4},
		{g.tombstones, capacity},
		{g.incoming, capacity * 4},
		{g.nearestLinkDue, capacity},
		{g.nodeLevels, capacity},
	}
	for _, growth := range growths {
		if err := growth.region.growToExactly(growth.bytes); err != nil {
			return err
		}
	}
	g.publishCapacity()
	return nil
}

func (g *graphMemory) ensureUpperRoom(levels int32) error {
	if levels < 1 {
		return nil
	}
	entries := uintptr(g.word(core.GraphWordUpperUsed).Load()) + uintptr(levels)*uintptr(g.upperStride)
	held := g.upper.length
	if err := g.upper.growTo(entries * 4); err != nil {
		return err
	}
	if g.upper.length != held {
		g.publishCapacity()
	}
	return nil
}

func (g *graphMemory) slots() int32 {
	return g.word(core.GraphWordSlots).Load()
}

func (g *graphMemory) nodeLevel(ordinal int32) int32 {
	if ordinal < 0 || uintptr(ordinal) >= g.nodeLevels.length {
		return -1
	}
	return int32(loadByte(g.nodeLevels.pointer(), int(ordinal))) - 1
}

func (g *graphMemory) holdsNode(ordinal int32) bool {
	return g.nodeLevel(ordinal) >= 0
}

func (g *graphMemory) tombstoned(ordinal int32) bool {
	if ordinal < 0 || uintptr(ordinal) >= g.tombstones.length {
		return false
	}
	return loadByte(g.tombstones.pointer(), int(ordinal)) == 1
}

func (g *graphMemory) holdsTombstone(ordinal int32) bool {
	return g.holdsNode(ordinal) && g.tombstoned(ordinal)
}

func (g *graphMemory) holdsLiveNode(ordinal int32) bool {
	return g.holdsNode(ordinal) && !g.tombstoned(ordinal)
}

func (g *graphMemory) nodeCount() int {
	return int(g.word(core.GraphWordNodeCount).Load())
}

func (g *graphMemory) tombstoneCount() int {
	return int(g.word(core.GraphWordTombstoneCount).Load())
}

func (g *graphMemory) size() int {
	return g.nodeCount() - g.tombstoneCount()
}

func (g *graphMemory) entryPoint() int32 {
	return g.word(core.GraphWordEntryPoint).Load()
}

func (g *graphMemory) holdsUnlinkedNode() bool {
	return g.word(core.GraphWordUnlinkedNodes).Load() != 0
}

func (g *graphMemory) bytes() int {
	total := 0
	for _, region := range g.every() {
		total += int(region.length)
	}
	return total
}

func (g *graphMemory) baseList(ordinal int32) []int32 {
	if !g.holdsNode(ordinal) {
		return nil
	}
	words := int32Values(g.level0.pointer(), int(g.level0.length/4))
	start := int(ordinal) * g.level0Stride
	count := int(words[start])
	count = max(0, min(count, g.level0Stride-1))
	return words[start+1 : start+1+count]
}

func (g *graphMemory) holdAlone() bool {
	return g.word(core.GraphWordLock).CompareAndSwap(0, graphLockHeldAlone)
}

func (g *graphMemory) releaseHold() {
	g.word(core.GraphWordLock).Store(0)
}

func (g *graphMemory) clone() (*graphMemory, error) {
	copied, err := newGraphMemory(g.shape, g.slotTable)
	if err != nil {
		return nil, err
	}
	pairs := []struct{ from, to *growable }{
		{g.nodeLevels, copied.nodeLevels}, {g.level0, copied.level0}, {g.upperBase, copied.upperBase},
		{g.upper, copied.upper}, {g.tombstones, copied.tombstones}, {g.incoming, copied.incoming},
		{g.nearestLinkDue, copied.nearestLinkDue}, {g.locks, copied.locks},
	}
	for _, pair := range pairs {
		if err := pair.to.growToExactly(pair.from.length); err != nil {
			copied.resource.drop()
			return nil, err
		}
		if pair.from != g.locks {
			copy(bytesAt(pair.to.pointer(), pair.from.length), bytesAt(pair.from.pointer(), pair.from.length))
		}
	}
	copied.copyHeaderFrom(g)
	copied.publishCapacity()
	copied.lineage = g.lineage
	return copied, nil
}

func (g *graphMemory) copyHeaderFrom(source *graphMemory) {
	words := []int{core.GraphWordEntryPoint, core.GraphWordTopLayer, core.GraphWordNodeCount,
		core.GraphWordTombstoneCount, core.GraphWordUnlinkedNodes, graphWordIncomingUncounted,
		core.GraphWordUpperUsed, core.GraphWordSlots}
	for _, index := range words {
		g.word(index).Store(source.word(index).Load())
	}
}

func (g *graphMemory) recountIncoming() {
	slots := int(g.slots())
	if slots == 0 {
		return
	}
	incoming := int32Values(g.incoming.pointer(), int(g.incoming.length/4))
	clear(incoming)
	for ordinal := range int32(slots) {
		for _, neighbour := range g.baseList(ordinal) {
			if neighbour == ordinal || !g.holdsNode(neighbour) {
				continue
			}
			incoming[neighbour]++
		}
	}
}

func (g *graphMemory) holdsUnreachedLiveNode() bool {
	entry := g.entryPoint()
	incoming := int32Values(g.incoming.pointer(), int(g.incoming.length/4))
	for ordinal := range g.slots() {
		if incoming[ordinal] == 0 && ordinal != entry && g.holdsLiveNode(ordinal) {
			return true
		}
	}
	return false
}
