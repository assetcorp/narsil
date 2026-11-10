package partition

import (
	"maps"
	"slices"
)

func (p *Partition) catchUp(write *Write) error {
	if p.pendingSide != write.side || len(p.pending) == 0 && !p.staleSide {
		return nil
	}
	target := p.sides[write.side]
	if p.staleSide || len(p.pending) >= SideCopyAtPendingOperations {
		if err := p.copySide(target, p.sides[1-write.side]); err != nil {
			return err
		}
	} else {
		err := target.applyAll(write.Workspace, p, p.pending)
		target.refreshView(p)
		if err != nil {
			p.markStale(target)
			return err
		}
	}
	p.retirePending()
	p.staleSide = false
	return nil
}

func (p *Partition) record(write *Write, operations []operation) {
	if len(operations) == 0 {
		return
	}
	p.pendingSide = 1 - write.side
	if p.staleSide {
		for at := range operations {
			operations[at].retire()
		}
		return
	}
	p.pending = append(p.pending, operations...)
}

func (p *Partition) retirePending() {
	for at := range p.pending {
		p.pending[at].retire()
	}
	p.pending = nil
}

func (p *Partition) markStale(target *side) {
	p.retirePending()
	p.staleSide = true
	target.frozen = nil
	target.release()
}

func (p *Partition) dropBacklog() {
	if !p.staleSide && len(p.pending) >= SideCopyAtPendingOperations {
		p.markStale(p.sides[p.pendingSide])
	}
}

func (p *Partition) freezesNext(side int) bool {
	held := p.sides[side]
	return held.growing.Bytes()+held.fields.RegionBytes() >= FreezeAtGrowingBytes
}

func (p *Partition) copySide(target, source *side) error {
	growing, err := source.growing.Clone()
	if err != nil {
		return err
	}
	set, err := source.fields.Clone()
	if err != nil {
		growing.Release()
		return err
	}
	target.release()
	frozen := make([]frozenSide, len(source.frozen))
	for at, held := range source.frozen {
		frozen[at] = frozenSide{segment: held.segment, state: held.state.Clone(), totals: slices.Clone(held.totals)}
	}
	source.gen.documents.copySide(source.index, target.index)
	target.gen, target.growing, target.fields, target.frozen = source.gen, growing, set, frozen
	target.viewFields, target.fieldCount = source.viewFields, source.fieldCount
	target.capacity, target.liveCount = source.capacity, source.liveCount
	target.ids, target.live = maps.Clone(source.ids), slices.Clone(source.live)
	target.refreshView(p)
	return nil
}

func (t *documentTable) copySide(from, to int) {
	t.writing.Lock()
	defer t.writing.Unlock()
	chunks := t.chunks.Load()
	if chunks == nil {
		return
	}
	remaining := t.reserved
	for _, chunk := range *chunks {
		for at := range chunk {
			if remaining == 0 {
				return
			}
			chunk[at].encoded[to] = chunk[at].encoded[from]
			remaining--
		}
	}
}
