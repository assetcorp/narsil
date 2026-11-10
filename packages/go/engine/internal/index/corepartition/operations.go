package corepartition

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/segments"
)

type operationKind uint8

const (
	insertDocument operationKind = iota
	removeDocument
	replaceDocument
	updateValues
	removeFrozenDocument
	freezeGrowing
	installMerge
	clearDocuments
	keepColumns
)

type operation struct {
	kind       operationKind
	id         string
	ordinal    uint32
	previous   uint32
	fieldCount int
	tokens     []core.FieldTokens
	removed    []core.FieldTokens
	document   map[string]any
	encoded    []byte
	before     map[string]any
	frozen     int
	frozenText []segments.Tokens
	freeze     *freezeResult
	merge      *mergeResult
	dropped    []*frozenSegment
	columns    []ColumnRequest
	failed     bool
}

type freezeResult struct {
	segment *frozenSegment
	next    *generation
	columns []ColumnRequest
}

type mergeResult struct {
	inputs  []*frozenSegment
	results []*segments.MergeResult
	output  []*frozenSegment
	late    []lateRemoval
}

type lateRemoval struct {
	input   int
	ordinal uint32
	tokens  []segments.Tokens
}

func (op *operation) retire() {
	if op.failed {
		return
	}
	for _, segment := range op.dropped {
		segment.release()
	}
	if op.merge != nil {
		for _, segment := range op.merge.inputs {
			segment.release()
		}
	}
}

func (s *side) finish(w *core.Workspace) error {
	if err := s.growing.EndBatch(); err != nil {
		return err
	}
	if err := s.fields.Settle(s.capacity); err != nil {
		return err
	}
	for _, held := range s.frozen {
		if err := held.state.Settle(w); err != nil {
			return err
		}
	}
	return nil
}

func (s *side) applyAll(w *core.Workspace, p *Partition, operations []operation) error {
	if err := s.growing.BeginBatch(); err != nil {
		return err
	}
	for at := range operations {
		op := &operations[at]
		if err := s.apply(w, p, op); err != nil && !op.failed {
			_ = s.finish(w)
			return err
		}
	}
	return s.finish(w)
}

func (s *side) apply(w *core.Workspace, p *Partition, op *operation) error {
	switch op.kind {
	case insertDocument:
		return s.insert(op)
	case removeDocument:
		return s.remove(op)
	case replaceDocument:
		return s.replace(op)
	case updateValues:
		return s.updateValues(op)
	case removeFrozenDocument:
		return s.removeFrozen(w, op)
	case freezeGrowing:
		return s.installFreeze(p, op.freeze)
	case installMerge:
		return s.installMerge(w, op.merge)
	case clearDocuments:
		return s.clear(p, op.freeze)
	case keepColumns:
		return s.keepColumns(op.columns)
	}
	return nil
}

func (s *side) insert(op *operation) error {
	if err := s.widenFields(op.fieldCount); err != nil {
		return err
	}
	if err := s.widenOrdinals(op.ordinal); err != nil {
		return err
	}
	if err := s.growing.Insert(op.ordinal, op.tokens); err != nil {
		return err
	}
	if err := s.fields.Insert(op.ordinal, s.capacity, op.document); err != nil {
		if undone := s.removeText(op.ordinal, op.tokens); undone != nil {
			return undone
		}
		return err
	}
	s.gen.documents.set(s.index, op.ordinal, op.encoded)
	s.ids[op.id] = op.ordinal
	s.setLive(op.ordinal)
	return nil
}

func (s *side) updateValues(op *operation) error {
	if err := s.fields.Update(op.ordinal, s.capacity, op.before, op.document); err != nil {
		return err
	}
	s.gen.documents.set(s.index, op.ordinal, op.encoded)
	return nil
}

func (s *side) removeText(ordinal uint32, tokens []core.FieldTokens) error {
	if len(tokens) == 0 {
		return s.growing.RemoveTextless(ordinal)
	}
	return s.growing.Remove(ordinal, tokens)
}

func (s *side) remove(op *operation) error {
	if err := s.fields.Remove(op.ordinal, op.before); err != nil {
		return err
	}
	if err := s.removeText(op.ordinal, op.removed); err != nil {
		return err
	}
	s.gen.documents.set(s.index, op.ordinal, nil)
	delete(s.ids, op.id)
	s.clearLive(op.ordinal)
	return nil
}

func (s *side) removeFrozen(w *core.Workspace, op *operation) error {
	held := &s.frozen[op.frozen]
	if err := held.state.Remove(w, op.ordinal, op.frozenText); err != nil {
		return err
	}
	held.removeLengths(op.ordinal)
	return nil
}

func (s *side) replace(op *operation) error {
	if err := s.widenFields(op.fieldCount); err != nil {
		return err
	}
	if err := s.widenOrdinals(op.ordinal); err != nil {
		return err
	}
	if err := s.growing.Insert(op.ordinal, op.tokens); err != nil {
		return err
	}
	if err := s.fields.Replace(op.previous, op.ordinal, s.capacity, op.before, op.document); err != nil {
		if undone := s.removeText(op.ordinal, op.tokens); undone != nil {
			return undone
		}
		return err
	}
	if err := s.removeText(op.previous, op.removed); err != nil {
		return err
	}
	s.gen.documents.set(s.index, op.previous, nil)
	s.gen.documents.set(s.index, op.ordinal, op.encoded)
	s.clearLive(op.previous)
	s.ids[op.id] = op.ordinal
	s.setLive(op.ordinal)
	return nil
}
