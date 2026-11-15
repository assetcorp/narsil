package partition

import (
	"sort"
	"unsafe"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
)

const documentEntryBytes = uint64(unsafe.Sizeof(documentEntry{}))

type WriteGrowth struct {
	FreezingBytes uint64
	CopiedBytes   uint64
	TableBytes    uint64
}

type tableFacts struct {
	reserved uint32
	chunks   int
}

type partitionFacts struct {
	freezing   uint64
	copied     uint64
	tables     [sideCount]tableFacts
	tableCount int
}

type GrowthSnapshot struct {
	partitions []partitionFacts
}

func (t *documentTable) facts() tableFacts {
	t.writing.Lock()
	defer t.writing.Unlock()
	facts := tableFacts{reserved: t.reserved}
	if chunks := t.chunks.Load(); chunks != nil {
		facts.chunks = len(*chunks)
	}
	return facts
}

func (t tableFacts) growthBytesFor(documents int) uint64 {
	if documents <= 0 {
		return 0
	}
	last := min(uint64(t.reserved)+uint64(documents)-1, uint64(^uint32(0)))
	needed, _ := documentChunkOf(uint32(last))
	bytes := uint64(0)
	for chunk := t.chunks; chunk <= needed; chunk++ {
		bytes += (uint64(1) << (chunk + documentTableFirstChunkBits)) * documentEntryBytes
	}
	return bytes
}

func (p *Partition) growthFacts(published int) partitionFacts {
	facts := partitionFacts{}
	source := p.sides[published]
	growing := source.growing.Bytes() + source.fields.RegionBytes()
	if growing >= FreezeAtGrowingBytes {
		facts.freezing = growing
	}
	if p.staleSide || len(p.pending) >= SideCopyAtPendingOperations {
		facts.copied = growing
	}
	for at, held := range p.sides {
		if held.gen == nil || (at > 0 && held.gen == p.sides[0].gen) {
			continue
		}
		facts.tables[facts.tableCount] = held.gen.documents.facts()
		facts.tableCount++
	}
	return facts
}

func (s *Sides) noteGrowth(published int) {
	facts := make([]partitionFacts, len(s.partitions))
	for at, partition := range s.partitions {
		facts[at] = partition.growthFacts(published)
	}
	s.growth.Store(&GrowthSnapshot{partitions: facts})
}

func (s *Sides) WriteGrowth() *GrowthSnapshot {
	return s.growth.Load()
}

func RouteOf(docID string, partitions int) int {
	return int(codec.FNV1aString(docID) % uint32(partitions))
}

func routedDocuments(docIDs []string, partitions int) ([]int, int) {
	routed := make([]int, partitions)
	unrouted := 0
	for _, docID := range docIDs {
		if docID == "" {
			unrouted++
			continue
		}
		routed[RouteOf(docID, partitions)]++
	}
	return routed, unrouted
}

func (facts partitionFacts) growthFor(documents int) WriteGrowth {
	growth := WriteGrowth{FreezingBytes: facts.freezing}
	for _, table := range facts.tables[:facts.tableCount] {
		growth.TableBytes = max(growth.TableBytes, table.growthBytesFor(documents))
	}
	return growth
}

func (snapshot *GrowthSnapshot) Burst(docIDs []string, burstOf func(WriteGrowth) float64) float64 {
	if snapshot == nil || len(snapshot.partitions) == 0 || len(docIDs) == 0 {
		return 0
	}
	routed, unrouted := routedDocuments(docIDs, len(snapshot.partitions))
	total := 0.0
	var reachable []float64
	for at, facts := range snapshot.partitions {
		total += burstOf(WriteGrowth{CopiedBytes: facts.copied})
		burst := burstOf(facts.growthFor(routed[at] + unrouted))
		switch {
		case routed[at] > 0:
			total += burst
		case unrouted > 0 && burst > 0:
			reachable = append(reachable, burst)
		}
	}
	sort.Float64s(reachable)
	for taken := 0; taken < unrouted && taken < len(reachable); taken++ {
		total += reachable[len(reachable)-1-taken]
	}
	return total
}
