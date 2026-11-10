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

func (s Snapshot) Has(id string) bool {
	return s.side.locate(id).found
}

func (s Snapshot) Document(id string) (*codec.Document, bool, error) {
	at := s.side.locate(id)
	if !at.found {
		return nil, false, nil
	}
	stored, held, err := s.side.document(at)
	if err != nil || !held {
		return nil, false, err
	}
	return codec.NewStoredDocument(stored.encoded, storedDecoding), true, nil
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

func (s Snapshot) IDAt(segment int, ordinal uint32) (string, bool) {
	at, live := s.segmentLocation(segment, ordinal)
	if !live {
		return "", false
	}
	if at.frozen >= 0 {
		return s.side.frozen[at.frozen].segment.idAt(ordinal)
	}
	document, held := s.side.gen.documents.at(s.side.index, ordinal)
	return document.id, held
}

func (s Snapshot) EachDocument(visit func(id string, document *codec.Document) bool) error {
	segments := len(s.side.frozen) + 1
	for segment := range segments {
		capacity := s.side.capacity
		if segment < len(s.side.frozen) {
			capacity = s.side.frozen[segment].segment.documentCount()
		}
		for ordinal := range capacity {
			at, live := s.segmentLocation(segment, ordinal)
			if !live {
				continue
			}
			stored, held, err := s.side.document(at)
			if err != nil {
				return err
			}
			if !held {
				return corruptedPartition("a live document holds no stored value", ordinal)
			}
			if !visit(stored.id, codec.NewStoredDocument(stored.encoded, storedDecoding)) {
				return nil
			}
		}
	}
	return nil
}

func (s Snapshot) SortedIDs() []string {
	ids := make([]string, 0, s.Count())
	for id := range s.side.ids {
		ids = append(ids, id)
	}
	for _, held := range s.side.frozen {
		for ordinal, id := range held.segment.ids {
			if !held.state.Tombstoned(uint32(ordinal)) {
				ids = append(ids, id)
			}
		}
	}
	slices.SortFunc(ids, text.CompareCodePoints)
	return ids
}
