package partition

import (
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/segments"
)

const adoptFrozen = attachFrozen + 1

type removalKey struct {
	segment int
	ordinal uint32
}

type frozenRemoval struct {
	removalKey
	id   string
	text []segments.Tokens
}

type Adoption struct {
	paged    []*segments.Paged
	kept     []bool
	listed   []*frozenSegment
	removals []frozenRemoval
	removed  map[removalKey]struct{}
}

func (p *Partition) PrepareAdoption(paged []*segments.Paged, kept []bool) (*Adoption, error) {
	adoption := &Adoption{paged: paged, kept: kept, listed: make([]*frozenSegment, len(paged)),
		removed: map[removalKey]struct{}{}}
	for at, segment := range paged {
		if !kept[at] {
			adoption.listed[at] = newPagedFrozenSegment(segment)
		}
	}
	analysing := &planner{partition: p}
	for at := range paged {
		for _, newer := range paged[at+1:] {
			if err := adoption.removeHeld(analysing, at, newer.Tombstones()); err != nil {
				return nil, err
			}
		}
	}
	return adoption, nil
}

func (a *Adoption) removeHeld(analysing *planner, at int, ids []string) error {
	if a.kept[at] {
		return nil
	}
	segment := a.listed[at]
	for _, id := range ids {
		ordinal, found, err := segment.ordinalOf(id)
		if err != nil {
			return err
		}
		key := removalKey{segment: at, ordinal: ordinal}
		if _, done := a.removed[key]; !found || done {
			continue
		}
		text, err := analysing.removedText(segment, ordinal)
		if err != nil {
			return err
		}
		a.removed[key] = struct{}{}
		a.removals = append(a.removals, frozenRemoval{removalKey: key, id: id, text: text.frozenTokens()})
	}
	return nil
}

func (a *Adoption) resolveKept(s *side) bool {
	for at, segment := range a.paged {
		if !a.kept[at] {
			continue
		}
		position := slices.IndexFunc(s.frozen, func(held frozenSide) bool { return held.segment.paged == segment })
		if position < 0 {
			return false
		}
		a.listed[at] = s.frozen[position].segment
	}
	return true
}

func (pl *planner) currentVersions(adoption *Adoption, ids []string) ([]Prepared, bool, error) {
	current := make([]Prepared, 0, len(ids))
	for _, id := range ids {
		at, err := pl.side.locate(id)
		if err != nil {
			return nil, false, err
		}
		if !at.found {
			continue
		}
		if at.frozen >= 0 && slices.Contains(adoption.listed, pl.side.frozen[at.frozen].segment) {
			return nil, false, nil
		}
		stored, held, err := pl.side.document(at)
		if err != nil {
			return nil, false, err
		}
		if !held {
			return nil, false, corruptedPartition("a live document holds no stored value", at.ordinal)
		}
		stored.encoded = slices.Clone(stored.encoded)
		values, err := decodeStored(stored)
		if err != nil {
			return nil, false, err
		}
		prepared, err := pl.partition.Prepare(id, values, stored.encoded)
		if err != nil {
			return nil, false, err
		}
		current = append(current, prepared)
	}
	return current, true, nil
}

func (a *Adoption) installed(s *side) (listed []*frozenSegment, positions []int, dropped []*frozenSegment) {
	positions = make([]int, len(a.listed))
	for at, segment := range a.listed {
		positions[at] = len(listed)
		if segment.documentCount() == 0 {
			positions[at] = -1
			dropped = append(dropped, segment)
			continue
		}
		listed = append(listed, segment)
	}
	for _, held := range s.frozen {
		if !slices.Contains(listed, held.segment) {
			dropped = append(dropped, held.segment)
		}
	}
	return listed, positions, dropped
}

func (p *Partition) Adopt(write *Write, adoption *Adoption, log *ChangeLog) (adopted bool, err error) {
	p.StopTracking(write, log)
	pl := p.planner(write)
	if log.replaced || !adoption.resolveKept(pl.side) {
		return false, nil
	}
	changed := log.changedIDs()
	current, adoptable, err := pl.currentVersions(adoption, changed)
	if err != nil || !adoptable {
		return false, err
	}
	for at := range adoption.paged {
		if err := adoption.removeHeld(pl, at, changed); err != nil {
			return false, err
		}
	}
	listed, positions, dropped := adoption.installed(pl.side)
	defer pl.commit(&err)
	if err := pl.run(operation{kind: adoptFrozen, adopted: listed, dropped: dropped,
		freeze: &freezeResult{next: newGeneration(), columns: p.settings.Kept.List()}}); err != nil {
		return true, err
	}
	for _, removal := range adoption.removals {
		if err := pl.run(operation{kind: removeFrozenDocument, id: removal.id, frozen: positions[removal.segment],
			ordinal: removal.ordinal, frozenText: removal.text}); err != nil {
			return true, err
		}
	}
	for at := range current {
		if err := pl.insert(&current[at]); err != nil {
			return true, err
		}
	}
	return true, nil
}

func (s Snapshot) PagedSegments() []*segments.Paged {
	var held []*segments.Paged
	for _, frozen := range s.side.frozen {
		if frozen.segment.paged != nil {
			held = append(held, frozen.segment.paged)
		}
	}
	return held
}

func (s *side) adopt(p *Partition, op *operation) error {
	held := s.frozen
	if err := s.restart(p, op.freeze); err != nil {
		return err
	}
	s.frozen = nil
	for _, segment := range op.adopted {
		if at := slices.IndexFunc(held, func(kept frozenSide) bool { return kept.segment == segment }); at >= 0 {
			s.frozen = append(s.frozen, held[at])
			continue
		}
		if err := s.attach(segment); err != nil {
			return err
		}
	}
	return nil
}
