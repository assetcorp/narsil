package partition

import (
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/segments"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type idTable interface {
	count() uint32
	idAt(ordinal uint32) (string, error)
	ordinalOf(id string) (uint32, bool, error)
	sortedIDs(excluded func(ordinal uint32) bool) ([]string, error)
	heldBytes() uint64
}

type residentIDs struct {
	ids      []string
	ordinals map[string]uint32
}

func newResidentIDs(ids []string) *residentIDs {
	ordinals := make(map[string]uint32, len(ids))
	for ordinal, id := range ids {
		ordinals[id] = uint32(ordinal)
	}
	return &residentIDs{ids: ids, ordinals: ordinals}
}

func (r *residentIDs) count() uint32 {
	return uint32(len(r.ids))
}

func (r *residentIDs) idAt(ordinal uint32) (string, error) {
	return r.ids[ordinal], nil
}

func (r *residentIDs) ordinalOf(id string) (uint32, bool, error) {
	ordinal, found := r.ordinals[id]
	return ordinal, found, nil
}

func (r *residentIDs) sortedIDs(excluded func(ordinal uint32) bool) ([]string, error) {
	kept := make([]string, 0, len(r.ids))
	for ordinal, id := range r.ids {
		if !excluded(uint32(ordinal)) {
			kept = append(kept, id)
		}
	}
	slices.SortFunc(kept, text.CompareCodePoints)
	return kept, nil
}

func (r *residentIDs) heldBytes() uint64 {
	var bytes uint64
	for _, id := range r.ids {
		bytes += uint64(len(id)) + idOverheadByte
	}
	return bytes
}

type pagedIDs struct {
	paged *segments.Paged
}

func (p pagedIDs) count() uint32 {
	return p.paged.DocumentCount()
}

func (p pagedIDs) idAt(ordinal uint32) (string, error) {
	return p.paged.IDAt(ordinal)
}

func (p pagedIDs) ordinalOf(id string) (uint32, bool, error) {
	return p.paged.OrdinalOf(id)
}

func (p pagedIDs) sortedIDs(excluded func(ordinal uint32) bool) ([]string, error) {
	count := p.count()
	kept := make([]string, 0, count)
	for position := range count {
		ordinal, err := p.paged.SortedOrdinal(position)
		if err != nil {
			return nil, err
		}
		if excluded(ordinal) {
			continue
		}
		id, err := p.paged.IDAt(ordinal)
		if err != nil {
			return nil, err
		}
		kept = append(kept, id)
	}
	return kept, nil
}

func (p pagedIDs) heldBytes() uint64 {
	return p.paged.IDSampleBytes()
}
