package partition

import (
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type ChangeLog struct {
	ids      map[string]struct{}
	replaced bool
	clears   uint64
}

func (log *ChangeLog) Clears() uint64 {
	return log.clears
}

func (log *ChangeLog) changedIDs() []string {
	ids := make([]string, 0, len(log.ids))
	for id := range log.ids {
		ids = append(ids, id)
	}
	slices.SortFunc(ids, text.CompareCodePoints)
	return ids
}

func (p *Partition) TrackChanges(_ *Write) *ChangeLog {
	log := &ChangeLog{ids: map[string]struct{}{}, clears: p.clears}
	p.changes = log
	return log
}

func (p *Partition) StopTracking(_ *Write, log *ChangeLog) {
	if p.changes == log {
		p.changes = nil
	}
}

func (p *Partition) noteChange(op *operation) {
	switch op.kind {
	case clearDocuments, attachFrozen, adoptFrozen:
		if op.kind == clearDocuments {
			p.clears++
		}
		if p.changes != nil {
			p.changes.replaced = true
		}
	case insertDocument, removeDocument, replaceDocument, updateValues, removeFrozenDocument:
		if p.changes != nil && !op.failed {
			p.changes.ids[op.id] = struct{}{}
		}
	}
}
