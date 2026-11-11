package segments

import (
	"errors"
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
)

type LateRemoval struct {
	Segment int
	Ordinal uint32
	Tokens  []Tokens
}

func (s *State) Clone() *State {
	copied := NewState(s.keyword, s.paged)
	copied.pageFailure = s.pageFailure
	copied.Core = core.FrozenSegmentState{
		Tombstones:         slices.Clone(s.Core.Tombstones),
		TombstoneCount:     slices.Clone(s.Core.TombstoneCount),
		RemovedDocuments:   slices.Clone(s.Core.RemovedDocuments),
		RemovedOccurrences: slices.Clone(s.Core.RemovedOccurrences),
		RemovedSurfaces:    slices.Clone(s.Core.RemovedSurfaces),
		RemovedSpellings:   slices.Clone(s.Core.RemovedSpellings),
		PendingHeader:      slices.Clone(s.Core.PendingHeader),
		PendingDocuments:   slices.Clone(s.Core.PendingDocuments),
		PendingTokens:      slices.Clone(s.Core.PendingTokens),
		PendingUnits:       slices.Clone(s.Core.PendingUnits),
	}
	return copied
}

func (r *MergeResult) Target(segment int, ordinal uint32) (uint32, bool) {
	for at, held := range r.Segments {
		mapping := r.Mappings[at]
		if held != segment || uint64(ordinal) >= uint64(len(mapping)) {
			continue
		}
		if target := mapping[ordinal]; target != core.MergeDroppedOrdinal {
			return target, true
		}
	}
	return 0, false
}

func (r *MergeResult) Install(w *core.Workspace, late []LateRemoval) (*State, error) {
	if r == nil || r.Frozen == nil {
		return nil, ErrInvalidInput
	}
	state := NewState(&r.Frozen.Keyword, nil)
	for _, removal := range late {
		target, held := r.Target(removal.Segment, removal.Ordinal)
		if !held {
			continue
		}
		if err := state.Remove(w, target, removal.Tokens); err != nil && !errors.Is(err, ErrTombstoned) {
			return nil, err
		}
	}
	if err := state.Settle(w); err != nil {
		return nil, err
	}
	return state, nil
}
