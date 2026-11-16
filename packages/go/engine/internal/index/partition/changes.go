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

func (p *Partition) trackedLogs() []*ChangeLog {
	if tracked := p.changes.Load(); tracked != nil {
		return *tracked
	}
	return nil
}

func (p *Partition) swapTracked(change func(logs []*ChangeLog) []*ChangeLog) {
	for {
		current := p.changes.Load()
		var held []*ChangeLog
		if current != nil {
			held = *current
		}
		next := change(slices.Clone(held))
		if p.changes.CompareAndSwap(current, &next) {
			return
		}
	}
}

func (p *Partition) TrackChanges(_ *Write) *ChangeLog {
	log := &ChangeLog{ids: map[string]struct{}{}, clears: p.clears}
	p.swapTracked(func(logs []*ChangeLog) []*ChangeLog { return append(logs, log) })
	return log
}

func (p *Partition) StopTracking(log *ChangeLog) {
	p.swapTracked(func(logs []*ChangeLog) []*ChangeLog {
		return slices.DeleteFunc(logs, func(held *ChangeLog) bool { return held == log })
	})
}

func (p *Partition) noteChange(op *operation) {
	changes := p.trackedLogs()
	switch op.kind {
	case clearDocuments, attachFrozen, adoptFrozen:
		if op.kind == clearDocuments {
			p.clears++
		}
		for _, log := range changes {
			log.replaced = true
		}
	case insertDocument, removeDocument, replaceDocument, updateValues, removeFrozenDocument:
		if op.failed {
			return
		}
		for _, log := range changes {
			log.ids[op.id] = struct{}{}
		}
	}
}
