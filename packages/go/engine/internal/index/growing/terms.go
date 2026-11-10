package growing

import "github.com/assetcorp/narsil/packages/go/engine/internal/core"

type termColumns struct {
	ids                *stringTable
	sliceStart         column[uint32]
	sliceClass         column[uint8]
	lengths            column[uint32]
	docFrequency       column[uint32]
	deadDocuments      column[uint32]
	totalTermFrequency column[float64]
	surfaceOccurrences column[float64]
	revision           column[uint32]
	flags              column[uint8]
	generation         uint32
}

func newTermColumns() (*termColumns, error) {
	ids, err := newStringTable(termTableStartCapacity)
	if err != nil {
		return nil, err
	}
	columns := &termColumns{ids: ids}
	if err := columns.resize(termTableStartCapacity); err != nil {
		columns.release()
		return nil, err
	}
	return columns, nil
}

func (c *termColumns) resize(capacity uint64) error {
	for _, held := range []*column[uint32]{&c.sliceStart, &c.lengths, &c.docFrequency, &c.deadDocuments, &c.revision} {
		if err := held.resize(capacity); err != nil {
			return err
		}
	}
	for _, held := range []*column[uint8]{&c.sliceClass, &c.flags} {
		if err := held.resize(capacity); err != nil {
			return err
		}
	}
	for _, held := range []*column[float64]{&c.totalTermFrequency, &c.surfaceOccurrences} {
		if err := held.resize(capacity); err != nil {
			return err
		}
	}
	return nil
}

func (c *termColumns) view() core.TermColumns {
	return core.TermColumns{
		SliceStart:         c.sliceStart.values,
		SliceClass:         c.sliceClass.values,
		Lengths:            c.lengths.values,
		DocFrequency:       c.docFrequency.values,
		DeadDocuments:      c.deadDocuments.values,
		TotalTermFrequency: c.totalTermFrequency.values,
		SurfaceOccurrences: c.surfaceOccurrences.values,
		Revision:           c.revision.values,
		Flags:              c.flags.values,
	}
}

func (c *termColumns) reserve(terms, units uint64) error {
	plan, err := c.ids.prepareCapacity(terms, units)
	if err != nil {
		return err
	}
	if plan.offsets > c.flags.len() {
		if err := c.resize(plan.offsets); err != nil {
			return err
		}
	}
	return c.ids.apply(plan)
}

func (c *termColumns) trim() error {
	count := min(c.flags.len(), max(termTableStartCapacity, c.ids.count()))
	if err := c.resize(count); err != nil {
		return err
	}
	return c.ids.trim(termTableStartCapacity)
}

func (c *termColumns) bytes() uint64 {
	return c.sliceStart.bytes() + c.sliceClass.bytes() + c.lengths.bytes() + c.docFrequency.bytes() +
		c.deadDocuments.bytes() + c.totalTermFrequency.bytes() + c.surfaceOccurrences.bytes() +
		c.revision.bytes() + c.flags.bytes() + c.ids.bytes()
}

func (c *termColumns) release() {
	for _, held := range []*column[uint32]{&c.sliceStart, &c.lengths, &c.docFrequency, &c.deadDocuments, &c.revision} {
		held.release()
	}
	c.sliceClass.release()
	c.flags.release()
	c.totalTermFrequency.release()
	c.surfaceOccurrences.release()
	c.ids.release()
}
