package partition

import (
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/query"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type Snapshot struct {
	partition *Partition
	side      *side
}

func (p *Partition) Written(write *Write) Snapshot {
	return Snapshot{partition: p, side: p.sides[write.side]}
}

func (p *Partition) Snapshot(read *Read) Snapshot {
	return Snapshot{partition: p, side: p.sides[read.side]}
}

func (s Snapshot) View() *query.View {
	return s.side.view
}

func (s Snapshot) SegmentSizes() []SegmentSize {
	return s.side.segmentSizes()
}

func (s Snapshot) Count() int {
	return s.side.documentCount()
}

func (s Snapshot) Has(id string) (bool, error) {
	at, err := s.side.locate(id)
	return at.found, err
}

func (s Snapshot) Document(id string) (*codec.Document, bool, error) {
	at, err := s.side.locate(id)
	if err != nil || !at.found {
		return nil, false, err
	}
	stored, held, err := s.side.document(at)
	if err != nil || !held {
		return nil, false, err
	}
	return codec.ShareStoredDocument(stored.encoded, storedDecoding), true, nil
}

func (s Snapshot) segmentLocation(segment int, ordinal uint32) (location, bool) {
	frozen := len(s.side.frozen)
	switch {
	case segment < frozen && segment >= 0:
		held := s.side.frozen[segment]
		if ordinal >= held.segment.documentCount() || held.state.Tombstoned(ordinal) {
			return location{}, false
		}
		return location{frozen: segment, ordinal: ordinal, found: true}, true
	case segment == frozen && s.side.holdsLive(ordinal):
		return location{frozen: -1, ordinal: ordinal, found: true}, true
	}
	return location{}, false
}

func (s Snapshot) Live(segment int, ordinal uint32) bool {
	_, live := s.segmentLocation(segment, ordinal)
	return live
}

func (s Snapshot) IDAt(segment int, ordinal uint32) (string, bool, error) {
	at, live := s.segmentLocation(segment, ordinal)
	if !live {
		return "", false, nil
	}
	if at.frozen >= 0 {
		return s.side.frozen[at.frozen].segment.idAt(ordinal)
	}
	document, held := s.side.gen.documents.at(s.side.index, ordinal)
	return document.id, held, nil
}

func (s Snapshot) SortedIDs() ([]string, error) {
	ids := make([]string, 0, s.Count())
	for id := range s.side.ids {
		ids = append(ids, id)
	}
	for _, held := range s.side.frozen {
		kept, err := held.segment.ids.sortedIDs(held.state.Tombstoned)
		if err != nil {
			return nil, err
		}
		ids = append(ids, kept...)
	}
	slices.SortFunc(ids, text.CompareCodePoints)
	return ids, nil
}
