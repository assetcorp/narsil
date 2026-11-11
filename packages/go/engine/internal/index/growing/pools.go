package growing

import "github.com/assetcorp/narsil/packages/go/engine/internal/core"

type postingPool struct {
	docIDs         column[uint32]
	frequencies    column[uint16]
	fieldIndices   column[uint16]
	positionStarts column[uint32]
	tracking       bool
	allocation     []uint32
	freeHeads      []uint32
}

func newPostingPool(tracking bool) (*postingPool, error) {
	pool := &postingPool{allocation: make([]uint32, allocationWords), freeHeads: freeHeadsFilled(), tracking: tracking}
	if err := pool.resize(postingPoolStartEntries); err != nil {
		pool.release()
		return nil, err
	}
	return pool, nil
}

func (p *postingPool) end() uint64 {
	return uint64(p.allocation[allocationEnd])
}

func (p *postingPool) freeEntries() uint64 {
	return uint64(p.allocation[allocationFree])
}

func (p *postingPool) resize(capacity uint64) error {
	if err := p.docIDs.resize(capacity); err != nil {
		return err
	}
	if err := p.frequencies.resize(capacity); err != nil {
		return err
	}
	if err := p.fieldIndices.resize(capacity); err != nil {
		return err
	}
	if p.tracking {
		return p.positionStarts.resize(capacity)
	}
	return nil
}

func (p *postingPool) prepareWrite(needed uint64) error {
	if needed <= p.docIDs.len() {
		return nil
	}
	capacity, err := grownCapacity(p.docIDs.len(), needed)
	if err != nil {
		return err
	}
	end := p.end()
	p.docIDs.clearFrom(end)
	p.frequencies.clearFrom(end)
	p.fieldIndices.clearFrom(end)
	p.positionStarts.clearFrom(end)
	return p.resize(capacity)
}

func (p *postingPool) trim() error {
	return p.resize(min(p.docIDs.len(), max(postingPoolStartEntries, p.end())))
}

func (p *postingPool) view() core.PostingPool {
	pool := core.PostingPool{
		DocIDs:       p.docIDs.values,
		Frequencies:  p.frequencies.values,
		FieldIndices: p.fieldIndices.values,
		Allocator:    core.SliceAllocator{Allocation: p.allocation, FreeHeads: p.freeHeads, SliceCapacities: sliceCapacities},
	}
	if p.tracking {
		pool.PositionStarts = p.positionStarts.values
	}
	return pool
}

func (p *postingPool) bytes() uint64 {
	return p.docIDs.bytes() + p.frequencies.bytes() + p.fieldIndices.bytes() + p.positionStarts.bytes() +
		uint64(len(p.allocation)+len(p.freeHeads))*4
}

func (p *postingPool) release() {
	p.docIDs.release()
	p.frequencies.release()
	p.fieldIndices.release()
	p.positionStarts.release()
}

type positionPool struct {
	values     column[uint32]
	allocation []uint32
}

func newPositionPool() (*positionPool, error) {
	pool := &positionPool{allocation: []uint32{1, 0}}
	if err := pool.values.resize(positionPoolStartValues); err != nil {
		pool.values.release()
		return nil, err
	}
	return pool, nil
}

func (p *positionPool) end() uint64 {
	return uint64(p.allocation[allocationEnd])
}

func (p *positionPool) freeValues() uint64 {
	return uint64(p.allocation[allocationFree])
}

func (p *positionPool) prepareWrite(needed uint64) error {
	if needed <= p.values.len() {
		return nil
	}
	capacity, err := grownCapacity(p.values.len(), needed)
	if err != nil {
		return err
	}
	p.values.clearFrom(p.end())
	return p.values.resize(capacity)
}

func (p *positionPool) trim() error {
	return p.values.resize(min(p.values.len(), max(positionPoolStartValues, p.end())))
}

func (p *positionPool) view() *core.PositionPool {
	return &core.PositionPool{Values: p.values.values, Allocation: p.allocation}
}

func (p *positionPool) bytes() uint64 {
	return p.values.bytes() + uint64(len(p.allocation))*4
}
