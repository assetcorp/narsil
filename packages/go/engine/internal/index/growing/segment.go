package growing

import (
	"errors"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

var ErrSegmentFull = errors.New("the growing keyword segment cannot take the document's surface or spelling counts")

type Options struct {
	TrackPositions bool
	PartialFields  bool
}

type Segment struct {
	terms     *termColumns
	postings  *postingPool
	positions *positionPool
	surfaces  *surfaceTable
	spellings *spellingTable
	retired   column[uint32]
	fields    fieldLengths
	view      core.GrowingSegment
	held      ordinalSet
	released  bool
}

func New(options Options) (*Segment, error) {
	segment := &Segment{fields: fieldLengths{documents: make([]uint32, 1)}}
	err := segment.allocate(options)
	if err != nil {
		segment.Release()
		return nil, err
	}
	segment.refreshView()
	return segment, nil
}

func (s *Segment) allocate(options Options) error {
	var err error
	if s.terms, err = newTermColumns(); err != nil {
		return err
	}
	if s.postings, err = newPostingPool(options.TrackPositions); err != nil {
		return err
	}
	if options.TrackPositions {
		if s.positions, err = newPositionPool(); err != nil {
			return err
		}
	}
	if options.PartialFields {
		if s.spellings, err = newSpellingTable(); err != nil {
			return err
		}
	}
	return s.retired.resize(retiredStartWords)
}

func (s *Segment) ReserveFields(ordinals uint32, fields int) error {
	if s.released {
		return releasedRefusal()
	}
	if fields < 0 {
		return narsilerr.New(narsilerr.CodeConfigInvalid, "The field length columns exceed their ordinal layout",
			map[string]any{"fields": float64(fields)})
	}
	if err := s.fields.reserve(uint64(ordinals), uint64(fields)); err != nil {
		return err
	}
	words := retiredWords(s.fields.ordinalCapacity)
	if words > s.retired.len() {
		if err := s.retired.resize(words); err != nil {
			return err
		}
	}
	s.held.grow(s.fields.ordinalCapacity)
	s.refreshView()
	return nil
}

func (s *Segment) SetPartial(field int, partial bool) error {
	if s.released {
		return releasedRefusal()
	}
	if field < 0 || uint64(field) >= s.fields.fieldCount {
		return narsilerr.New(narsilerr.CodeConfigInvalid, "The partial-word flag names a field the segment does not hold",
			map[string]any{"field": float64(field)})
	}
	if partial && s.spellings == nil {
		return narsilerr.New(narsilerr.CodeConfigInvalid,
			"A partial-word field needs a segment created with partial-word fields", map[string]any{"field": float64(field)})
	}
	var flag uint8
	if partial {
		flag = 1
	}
	s.fields.partial.values[field] = flag
	return nil
}

func retiredWords(capacity uint64) uint64 {
	if capacity == 0 {
		return 1
	}
	return (capacity-1)/32 + 1
}

func (s *Segment) View() *core.GrowingSegment {
	return &s.view
}

func (s *Segment) refreshView() {
	if s.released {
		s.view = core.GrowingSegment{}
		return
	}
	view := core.GrowingSegment{
		Terms:             s.terms.ids.view(),
		Columns:           s.terms.view(),
		Postings:          s.postings.view(),
		Retired:           s.retired.values[:retiredWords(s.fields.ordinalCapacity)],
		FieldLengths:      s.fields.values.values,
		TotalDocuments:    s.fields.documents,
		TotalFieldLengths: s.fields.totals.values,
		PartialFields:     s.fields.partial.values,
		OrdinalCapacity:   uint32(s.fields.ordinalCapacity),
	}
	if s.positions != nil {
		view.Positions = s.positions.view()
	}
	if s.surfaces != nil {
		table := s.surfaces.view()
		view.Surfaces = &table
	}
	if s.spellings != nil {
		view.Spellings = s.spellings.view()
	}
	s.view = view
}

func (s *Segment) Bytes() uint64 {
	if s.released {
		return 0
	}
	total := s.terms.bytes() + s.postings.bytes() + s.retired.bytes() + s.fields.bytes()
	if s.positions != nil {
		total += s.positions.bytes()
	}
	if s.surfaces != nil {
		total += s.surfaces.bytes()
	}
	if s.spellings != nil {
		total += s.spellings.bytes()
	}
	return total
}

func (s *Segment) Release() {
	if s.released {
		return
	}
	s.released = true
	if s.terms != nil {
		s.terms.release()
	}
	if s.postings != nil {
		s.postings.release()
	}
	if s.positions != nil {
		s.positions.values.release()
	}
	if s.surfaces != nil {
		s.surfaces.release()
	}
	if s.spellings != nil {
		s.spellings.release()
	}
	s.retired.release()
	s.fields.release()
	s.held = ordinalSet{}
	s.refreshView()
}

func releasedRefusal() error {
	return narsilerr.New(narsilerr.CodePartitionCorrupted, "The growing keyword segment was released", nil)
}

func invalidTokens() error {
	return refusal(&core.StatusError{Operation: "indexTerms", Status: core.StatusInvalidArgument})
}

func refusal(cause error) error {
	var status *core.StatusError
	if errors.As(cause, &status) {
		return narsilerr.Wrap(narsilerr.CodePartitionCorrupted, "The keyword segment refused a document publication", cause,
			map[string]any{"status": status.Status.String(), "operation": status.Operation})
	}
	return cause
}
