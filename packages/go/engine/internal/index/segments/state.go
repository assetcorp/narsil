package segments

import (
	"errors"
	"fmt"
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
)

type Tokens struct {
	Field   string
	Records []core.TokenRecord
	Units   []uint16
}

type State struct {
	keyword  *Keyword
	paged    *core.FrozenPagedRemovals
	Core     core.FrozenSegmentState
	entries  []uint32
	values   []float64
	prepared uint64
}

type Prepared struct {
	state       *State
	preparation uint64
	count       int
	header      [3]uint32
}

func NewState(keyword *Keyword, paged *core.FrozenPagedRemovals) *State {
	segment := &keyword.Segment
	terms := len(segment.Terms.Counts)
	var surfaces, spellings int
	if segment.Surfaces != nil {
		surfaces = len(segment.Surfaces.Counts)
	}
	if segment.Spellings != nil {
		spellings = len(segment.Spellings.Counts)
	}
	return &State{
		keyword: keyword,
		paged:   paged,
		Core: core.FrozenSegmentState{
			Tombstones:         make([]uint32, bitsetWords(segment.DocumentCount)),
			TombstoneCount:     make([]uint32, 1),
			RemovedDocuments:   make([]uint32, terms),
			RemovedOccurrences: make([]float64, terms),
			RemovedSurfaces:    make([]uint32, surfaces),
			RemovedSpellings:   make([]uint32, spellings),
			PendingHeader:      make([]uint32, core.PendingHeaderWords),
		},
		entries: make([]uint32, PreparedRemovalReplacements*core.FrozenRemovalEntryWords),
		values:  make([]float64, PreparedRemovalReplacements),
	}
}

func (s *State) Tombstoned(ordinal uint32) bool {
	word := uint64(ordinal) / 32
	return word < uint64(len(s.Core.Tombstones)) && s.Core.Tombstones[word]&(1<<(ordinal%32)) != 0
}

func (s *State) Settled() bool {
	header := s.Core.PendingHeader
	return header[core.PendingDocuments] == 0 && header[core.PendingTokens] == 0 && header[core.PendingUnits] == 0
}

func (s *State) Settle(w *core.Workspace) error {
	if s.Settled() {
		return nil
	}
	return w.SettleFrozenState(&s.keyword.Segment, &s.Core, s.paged)
}

func (s *State) fieldTokens(tokens []Tokens) ([]core.FieldTokens, error) {
	partial := s.keyword.Segment.PartialFields
	fields := make([]core.FieldTokens, 0, len(tokens))
	for _, entry := range tokens {
		field := -1
		for at, name := range s.keyword.FieldNames {
			if name == entry.Field {
				field = at
			}
		}
		if field < 0 || field >= len(partial) {
			return nil, fmt.Errorf("%w: the segment holds no field %q", ErrInvalidInput, entry.Field)
		}
		var kept []core.TokenRecord
		for _, record := range entry.Records {
			if record.SurfaceOffset != core.TokenNoSurface || partial[field] != 0 {
				kept = append(kept, record)
			}
		}
		if len(kept) > 0 {
			fields = append(fields, core.FieldTokens{Field: uint16(field), Tokens: kept, Units: entry.Units})
		}
	}
	slices.SortFunc(fields, func(left, right core.FieldTokens) int {
		return int(left.Field) - int(right.Field)
	})
	for at := 1; at < len(fields); at++ {
		if fields[at].Field == fields[at-1].Field {
			return nil, fmt.Errorf("%w: the tokens name field %q twice", ErrInvalidInput,
				s.keyword.FieldNames[fields[at].Field])
		}
	}
	return fields, nil
}

func (s *State) Prepare(w *core.Workspace, ordinal uint32, tokens []Tokens) (*Prepared, error) {
	if ordinal >= s.keyword.Segment.DocumentCount {
		return nil, fmt.Errorf("%w: ordinal %d is past the segment's %d documents", ErrInvalidInput, ordinal,
			s.keyword.Segment.DocumentCount)
	}
	if s.Tombstoned(ordinal) {
		return nil, ErrTombstoned
	}
	fields, err := s.fieldTokens(tokens)
	if err != nil {
		return nil, err
	}
	if err := s.growPending(fields); err != nil {
		return nil, err
	}
	output := &core.FrozenRemovalOutput{Entries: s.entries, Values: s.values}
	count, err := w.PrepareFrozenRemoval(&s.keyword.Segment, &s.Core, ordinal, fields, s.paged, output)
	var status *core.StatusError
	if errors.As(err, &status) && status.Status == core.StatusNeedsRoom {
		if err := s.growPending(fields); err != nil {
			return nil, err
		}
		count, err = w.PrepareFrozenRemoval(&s.keyword.Segment, &s.Core, ordinal, fields, s.paged, output)
	}
	if err != nil {
		return nil, err
	}
	s.prepared++
	header := s.Core.PendingHeader
	return &Prepared{
		state:       s,
		preparation: s.prepared,
		count:       count,
		header:      [3]uint32{header[core.PendingDocuments], header[core.PendingTokens], header[core.PendingUnits]},
	}, nil
}

func (p *Prepared) Publish() error {
	s := p.state
	header := s.Core.PendingHeader
	if p.preparation != s.prepared || header[core.PendingDocuments] != p.header[0] ||
		header[core.PendingTokens] != p.header[1] || header[core.PendingUnits] != p.header[2] {
		return ErrStalePrepare
	}
	s.prepared++
	for at := range p.count {
		var target []uint32
		switch s.entries[at*core.FrozenRemovalEntryWords] {
		case tombstoneWordKind:
			target = s.Core.Tombstones
		case tombstoneCountKind:
			target = s.Core.TombstoneCount
		case pendingHeaderKind:
			target = s.Core.PendingHeader
		}
		entry := s.entries[at*core.FrozenRemovalEntryWords+1]
		if uint64(entry) >= uint64(len(target)) {
			return fmt.Errorf("%w: the core prepared a replacement outside the state", ErrInvalidInput)
		}
		target[entry] = uint32(s.values[at])
	}
	return nil
}

func (s *State) Remove(w *core.Workspace, ordinal uint32, tokens []Tokens) error {
	prepared, err := s.Prepare(w, ordinal, tokens)
	if err != nil {
		return err
	}
	return prepared.Publish()
}
