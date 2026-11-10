package growing

import (
	"errors"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
)

func statusOf(err error) core.Status {
	var status *core.StatusError
	if errors.As(err, &status) {
		return status.Status
	}
	return core.StatusOK
}

func (s *Segment) Insert(ordinal uint32, fields []core.FieldTokens) error {
	if s.released {
		return releasedRefusal()
	}
	if s.held.has(ordinal) {
		return heldRefusal(ordinal, true)
	}
	if s.ordinalRetired(ordinal) {
		return retiredRefusal(ordinal)
	}
	workspace, err := core.AcquireWorkspace()
	if err != nil {
		return err
	}
	defer workspace.Release()
	defer s.refreshView()
	if err := s.preparePublication(workspace); err != nil {
		return err
	}
	counted := s.countsNonemptyTerms()
	s.refreshView()
	err = workspace.IndexTerms(&s.view, ordinal, fields)
	if statusOf(err) == core.StatusNeedsRoom {
		if err := s.reserveDocument(fields); err != nil {
			return err
		}
		s.refreshView()
		err = workspace.IndexTerms(&s.view, ordinal, fields)
	}
	if statusOf(err) == core.StatusSegmentFull {
		return ErrSegmentFull
	}
	if err == nil {
		s.held.set(ordinal)
	}
	return s.accept(err, counted)
}

func (s *Segment) reserveDocument(fields []core.FieldTokens) error {
	capacity, err := measureDocument(fields, s.fields.partial.values)
	if err != nil {
		return err
	}
	if err := s.reservePostings(capacity); err != nil {
		return err
	}
	if len(capacity.surfaces.texts) > 0 {
		if s.surfaces == nil {
			if s.surfaces, err = newSurfaceTable(); err != nil {
				return err
			}
		}
		if err := reserveStrings(s.surfaces, capacity.surfaces.texts, nil); err != nil {
			return err
		}
	}
	if s.spellings != nil {
		return s.spellings.reserveWords(capacity.spellings.texts)
	}
	return nil
}

func (s *Segment) Remove(ordinal uint32, fields []core.FieldTokens) error {
	if s.released {
		return releasedRefusal()
	}
	if !s.held.has(ordinal) {
		return heldRefusal(ordinal, false)
	}
	workspace, err := core.AcquireWorkspace()
	if err != nil {
		return err
	}
	defer workspace.Release()
	defer s.refreshView()
	if err := s.preparePublication(workspace); err != nil {
		return err
	}
	counted := s.countsNonemptyTerms()
	s.refreshView()
	err = workspace.RemoveDocument(&s.view, ordinal, fields)
	if err == nil {
		s.held.clear(ordinal)
	}
	return s.accept(err, counted)
}

func (s *Segment) RemoveTextless(ordinal uint32) error {
	if s.released {
		return releasedRefusal()
	}
	if !s.held.has(ordinal) {
		return heldRefusal(ordinal, false)
	}
	if !s.retireTextless(uint64(ordinal)) {
		return refusal(&core.StatusError{Operation: "removeTextless", Status: core.StatusInvalidArgument})
	}
	s.held.clear(ordinal)
	return nil
}

func (s *Segment) BeginBatch() error {
	return s.batch(false)
}

func (s *Segment) EndBatch() error {
	return s.batch(true)
}

func (s *Segment) batch(ending bool) error {
	if s.released {
		return releasedRefusal()
	}
	if s.holdsNoKeywords() {
		return nil
	}
	workspace, err := core.AcquireWorkspace()
	if err != nil {
		return err
	}
	defer workspace.Release()
	defer s.refreshView()
	if err := s.finishCopies(); err != nil {
		return err
	}
	s.refreshView()
	if ending {
		return s.accept(workspace.EndBatch(&s.view), nonemptyUnchanged)
	}
	return s.accept(workspace.BeginBatch(&s.view), nonemptyUnchanged)
}

func (s *Segment) holdsNoKeywords() bool {
	positionsEmpty := s.positions == nil || (s.positions.end() <= 1 && s.positions.freeValues() == 0)
	return s.terms.ids.count() == 0 && s.postings.end() == 0 && s.postings.freeEntries() == 0 && positionsEmpty &&
		(s.surfaces == nil || s.surfaces.strings.count() == 0) &&
		(s.spellings == nil || s.spellings.strings.count() == 0)
}

func (s *Segment) finishCopies() error {
	if err := s.postings.prepareWrite(s.postings.end()); err != nil {
		return err
	}
	if s.positions != nil {
		return s.positions.prepareWrite(s.positions.end())
	}
	return nil
}

func (s *Segment) preparePublication(workspace *core.Workspace) error {
	if err := s.finishCopies(); err != nil {
		return err
	}
	ids := s.terms.ids
	dead := ids.count() - min(ids.count(), ids.live())
	termVacuum := dead >= termVacuumMinDeadTerms && dead > ids.live()
	freeEntries := s.postings.freeEntries()
	postingVacuum := freeEntries >= poolVacuumMinFreeEntries &&
		float64(freeEntries) > float64(s.postings.end())*poolVacuumFreeFraction
	positionVacuum := false
	if s.positions != nil {
		free := s.positions.freeValues()
		positionVacuum = free >= positionVacuumMinFreeValue && float64(free) > float64(s.positions.end())*poolVacuumFreeFraction
	}
	sparse := (s.surfaces != nil && s.surfaces.sparse()) || (s.spellings != nil && s.spellings.surfaceTable.sparse())
	if !termVacuum && !postingVacuum && !positionVacuum && !sparse {
		return nil
	}
	s.refreshView()
	return s.accept(workspace.EndBatch(&s.view), nonemptyUnchanged)
}

func (s *Segment) accept(err error, change nonemptyChange) error {
	if err != nil {
		return refusal(err)
	}
	generation := s.terms.ids.header[headerGeneration]
	compacted := generation != s.terms.generation
	s.acceptNonempty(change, compacted)
	if !compacted {
		return nil
	}
	s.terms.generation = generation
	s.terms.ids.acceptCompaction()
	return s.trim()
}

func (s *Segment) trim() error {
	if err := s.terms.trim(); err != nil {
		return err
	}
	if err := s.postings.trim(); err != nil {
		return err
	}
	if s.positions != nil {
		if err := s.positions.trim(); err != nil {
			return err
		}
	}
	if s.surfaces != nil {
		if err := s.surfaces.trim(nil); err != nil {
			return err
		}
	}
	if s.spellings != nil {
		return s.spellings.trim()
	}
	return nil
}
