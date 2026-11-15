package partition

import "unsafe"

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
	s.growth.Store(&facts)
}

func (s *Sides) WriteGrowth(documents int) WriteGrowth {
	growth := WriteGrowth{}
	held := s.growth.Load()
	if held == nil {
		return growth
	}
	for _, facts := range *held {
		growth.FreezingBytes += facts.freezing
		growth.CopiedBytes += facts.copied
		tableBytes := uint64(0)
		for _, table := range facts.tables[:facts.tableCount] {
			tableBytes = max(tableBytes, table.growthBytesFor(documents))
		}
		growth.TableBytes += tableBytes
	}
	return growth
}
