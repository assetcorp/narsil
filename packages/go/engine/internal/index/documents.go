package index

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partition"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/projection"
)

type documentLookup struct {
	index   *Index
	reading *Reading
	held    map[string]*codec.Document
	missing map[string]struct{}
	handed  map[string]struct{}
	err     error
}

func (l *documentLookup) handOver(id string) bool {
	if _, handed := l.handed[id]; handed {
		return false
	}
	if l.handed == nil {
		l.handed = map[string]struct{}{}
	}
	l.handed[id] = struct{}{}
	return true
}

func newDocumentLookup(index *Index, reading *Reading) *documentLookup {
	return &documentLookup{index: index, reading: reading, held: map[string]*codec.Document{}, missing: map[string]struct{}{}}
}

func (l *documentLookup) snapshotOf(id string) partition.Snapshot {
	return l.reading.Snapshots[l.index.partitionOf(id)]
}

func (l *documentLookup) keepOnly() {
	l.reading = nil
}

func (l *documentLookup) stored(id string) *codec.Document {
	if held, found := l.held[id]; found {
		return held
	}
	if _, absent := l.missing[id]; absent || l.err != nil || l.reading == nil {
		return nil
	}
	found, present, err := l.snapshotOf(id).Document(id)
	if err != nil {
		l.err = err
		return nil
	}
	if !present {
		l.missing[id] = struct{}{}
		return nil
	}
	l.held[id] = found
	return found
}

func (l *documentLookup) shownAs(id string, shown projection.Projection) *codec.Document {
	return l.checked(id, shown.Failure)
}

func (l *documentLookup) withFields(id string, fields []string) *codec.Document {
	return l.checked(id, func(held *codec.Document) error {
		for _, field := range fields {
			if err := projection.FieldFailure(held, field); err != nil {
				return err
			}
		}
		return nil
	})
}

func (l *documentLookup) checked(id string, failure func(*codec.Document) error) *codec.Document {
	held := l.stored(id)
	if held == nil {
		return nil
	}
	if err := failure(held); err != nil {
		if l.err == nil {
			l.err = err
		}
		return nil
	}
	return held
}

func (l *documentLookup) has(id string) bool {
	if _, found := l.held[id]; found {
		return true
	}
	if _, absent := l.missing[id]; absent || l.err != nil || l.reading == nil {
		return false
	}
	present, err := l.snapshotOf(id).Has(id)
	if err != nil {
		l.err = err
	}
	return present
}

func (l *documentLookup) failure() error {
	return l.err
}
