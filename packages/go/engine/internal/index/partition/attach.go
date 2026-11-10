package partition

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/segments"
)

const attachFrozen = keepColumns + 1

func (p *Partition) attachSegment(write *Write, attached *frozenSegment, ids []string) (err error) {
	pl := p.planner(write)
	defer pl.commit(&err)
	for _, id := range ids {
		at, err := pl.side.locate(id)
		if err != nil {
			return err
		}
		if at.found {
			return corruptedPartition("an attached segment holds a document that the partition already holds", 0)
		}
	}
	return pl.run(operation{kind: attachFrozen, freeze: &freezeResult{segment: attached}})
}

func (p *Partition) Attach(write *Write, frozen *segments.Frozen, ids []string, documents [][]byte) error {
	if frozen == nil || uint32(len(ids)) != frozen.DocumentCount() || len(documents) != len(ids) {
		return corruptedPartition("an attached segment needs one ID and one stored document per ordinal", 0)
	}
	return p.attachSegment(write, newFrozenSegment(frozen, ids, documents), ids)
}

func (p *Partition) AttachPaged(write *Write, paged *segments.Paged) error {
	if paged == nil || paged.DocumentCount() == 0 {
		return corruptedPartition("an attached paged segment needs one document at least", 0)
	}
	return p.attachSegment(write, newPagedFrozenSegment(paged), nil)
}

func (s *side) attach(segment *frozenSegment) error {
	for _, name := range segment.keyword().FieldNames {
		s.viewFields = max(s.viewFields, int(s.names.number(name))+1)
	}
	s.frozen = append(s.frozen[:len(s.frozen):len(s.frozen)], newFrozenSide(segment, segment.newState()))
	return nil
}
