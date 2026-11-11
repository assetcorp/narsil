package engine

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/wal"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist"
)

type derivedChange struct {
	seqNo      uint64
	kind       ChangeType
	documentID string
	document   []byte
	previous   []byte
}

func derivedOf(entry wal.Entry, kind ChangeType, document []byte, previous []byte) derivedChange {
	return derivedChange{seqNo: entry.SeqNo, kind: kind, documentID: entry.DocumentID, document: document,
		previous: previous}
}

func heldPrevious(entry wal.Entry) []byte {
	if entry.Previous == wal.PreviousDocumentHeld {
		return entry.PreviousDocument
	}
	return nil
}

func derivedChangeOf(entry wal.Entry) derivedChange {
	previous := heldPrevious(entry)
	switch {
	case entry.Operation == wal.OperationDelete:
		return derivedOf(entry, ChangeRemove, nil, previous)
	case entry.Previous == wal.PreviousDocumentAbsent:
		return derivedOf(entry, ChangePut, entry.Document, nil)
	case previous == nil:
		return derivedOf(entry, ChangeInsert, entry.Document, nil)
	}
	return derivedOf(entry, ChangeUpdate, entry.Document, previous)
}

func filteredChangeOf(entry wal.Entry, match persist.FilterMatch) (derivedChange, bool) {
	var after []byte
	if entry.Operation == wal.OperationIndex {
		after = entry.Document
	}
	afterMatches := after != nil && match.After
	if entry.Previous == wal.PreviousDocumentAbsent {
		if afterMatches {
			return derivedOf(entry, ChangePut, after, nil), true
		}
		return derivedOf(entry, ChangeRemove, nil, nil), true
	}
	before := heldPrevious(entry)
	beforeMatches := before != nil && match.Before
	switch {
	case beforeMatches && afterMatches:
		return derivedOf(entry, ChangeUpdate, after, before), true
	case afterMatches:
		return derivedOf(entry, ChangeInsert, after, nil), true
	case beforeMatches:
		return derivedOf(entry, ChangeRemove, nil, before), true
	}
	return derivedChange{}, false
}

func (derived derivedChange) decoded(durable *persist.Durable) (Change, error) {
	change := Change{SeqNo: derived.seqNo, Type: derived.kind, DocumentID: derived.documentID}
	if derived.document != nil {
		document, err := durable.LoggedDocument(derived.document)
		if err != nil {
			return Change{}, err
		}
		change.Document = document
	}
	if derived.previous != nil {
		document, err := durable.LoggedDocument(derived.previous)
		if err != nil {
			return Change{}, err
		}
		change.PreviousDocument = document
	}
	return change, nil
}
