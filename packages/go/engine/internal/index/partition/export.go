package partition

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/segments"
)

type Selection struct {
	Source  segments.Source
	segment *frozenSegment
}

func (s Selection) DocumentCount() uint32 {
	return s.segment.documentCount()
}

func (s Selection) Keeps(ordinal uint32) bool {
	return !s.Source.State.Tombstoned(ordinal) && (s.Source.Keep == nil || s.Source.Keep(ordinal))
}

func (s Selection) Document(ordinal uint32) (string, []byte, error) {
	stored, held, err := s.segment.documentAt(ordinal)
	if err != nil {
		return "", nil, err
	}
	if !held {
		return "", nil, corruptedPartition("a frozen ordinal holds no stored document", ordinal)
	}
	return stored.id, stored.encoded, nil
}

func (s Selection) Paged() bool {
	return s.segment.paged != nil
}

func (s Selection) PagedSegment() *segments.Paged {
	return s.segment.paged
}

func (s Selection) Keeping(keep func(ordinal uint32) bool) Selection {
	narrowed := s
	narrowed.Source.Keep = keep
	return narrowed
}

func (s Snapshot) GrowingCount() int {
	return s.side.liveCount
}

func (s Snapshot) Selections() []Selection {
	selections := make([]Selection, 0, len(s.side.frozen))
	analysing := &planner{partition: s.partition}
	for _, held := range s.side.frozen {
		segment := held.segment
		selections = append(selections, Selection{segment: segment, Source: segments.Source{
			Segment: len(selections), Frozen: segment.frozen, State: held.state.Clone(),
			Tokens: func(ordinal uint32) ([]segments.Tokens, error) {
				text, err := analysing.removedText(segment, ordinal)
				return text.frozenTokens(), err
			}}})
	}
	return selections
}
