package engine

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/memory"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

func (n *Narsil) boundOutsideTheIndex(holder indexHolder, release func(), bound func() error) (*indexEntry, func(),
	error) {
	defer n.holdRetiredIndexes()()
	return holder.outside(release, bound)
}

func (n *Narsil) reserveDocumentOutsideCallerCode(holder indexHolder, entry *indexEntry, release func(), docID string,
	document *model.Document) (*indexEntry, func(), *memory.Reservation, error) {
	shape := entry.memoryShape()
	if !shape.CallsCallerCode() {
		reservation, err := n.memory.reserveDocument(entry, shape, docID, document)
		return entry, release, reservation, err
	}
	held := entry
	var reservation *memory.Reservation
	entry, release, err := n.boundOutsideTheIndex(holder, release, func() error {
		var err error
		reservation, err = n.memory.reserveDocument(held, shape, docID, document)
		return err
	})
	if err != nil {
		if reservation != nil {
			reservation.Release()
		}
		return entry, release, nil, err
	}
	return entry, release, reservation, nil
}
