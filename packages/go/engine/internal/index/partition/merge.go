package partition

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/frozen"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type SegmentSize struct {
	Segment       *frozen.Segment
	LiveDocuments int
}

func (v View) FrozenSegmentSizes() []SegmentSize {
	if v.tailOnly {
		return nil
	}
	sizes := make([]SegmentSize, len(v.state.frozen))
	for at, sub := range v.state.frozen {
		sizes[at] = SegmentSize{Segment: sub.segment, LiveDocuments: sub.liveCount()}
	}
	return sizes
}

func (p *Partition) missingSegment() error {
	return narsilerr.New(narsilerr.CodePartitionCorrupted,
		"Partition "+text.FormatNumber(float64(p.id))+" does not hold a frozen segment chosen for merging",
		map[string]any{"partitionId": p.id})
}

func (p *Partition) mergeInputs(segments []*frozen.Segment) ([]frozen.MergeInput, error) {
	inputs := make([]frozen.MergeInput, len(segments))
	var failure error
	p.pair.read(func(state *side) {
		for at, segment := range segments {
			sub := state.frozenSubOf(segment)
			if sub == nil {
				failure = p.missingSegment()
				return
			}
			inputs[at] = frozen.MergeInput{Segment: segment, Removed: sub.tombstones.Clone(), Surfaces: sub.liveSurfaces()}
		}
	})
	return inputs, failure
}

func (p *Partition) MergeSegments(segments []*frozen.Segment) (bool, error) {
	p.merging.Lock()
	defer p.merging.Unlock()
	return p.mergeHeld(segments)
}

func (p *Partition) MergePicked(pick func(sizes []SegmentSize) []*frozen.Segment) (bool, error) {
	p.merging.Lock()
	defer p.merging.Unlock()
	var sizes []SegmentSize
	p.Read(func(view View) { sizes = view.FrozenSegmentSizes() })
	return p.mergeHeld(pick(sizes))
}

func (p *Partition) mergeHeld(segments []*frozen.Segment) (bool, error) {
	if len(segments) < 2 {
		return false, nil
	}
	inputs, err := p.mergeInputs(segments)
	if err != nil {
		return false, err
	}
	analysed, err := p.analysisFor(false)
	if err != nil {
		return false, err
	}
	documents, err := frozen.MergedDocuments(inputs)
	if err != nil {
		return false, err
	}
	var merged *frozen.Segment
	if len(documents) > 0 {
		spellings, err := p.mergedSpellings(inputs, analysed.Pass)
		if err != nil {
			return false, err
		}
		merged, err = frozen.Merge(inputs, documents, indexesOf(documents, p.fields), spellings)
		if err != nil {
			return false, err
		}
	}
	p.pair.writer.Lock()
	defer p.pair.writer.Unlock()
	active := p.pair.activeState()
	var carried []carriedTombstone
	for at, input := range inputs {
		sub := active.frozenSubOf(segments[at])
		if sub == nil {
			return false, nil
		}
		arrived := sub.tombstones.Clone()
		arrived.AndNotWith(input.Removed)
		if merged == nil {
			continue
		}
		var failure error
		arrived.ForEach(func(ordinal uint32) bool {
			id, _ := input.Segment.IDAt(ordinal)
			target, held := merged.Ordinal(id)
			if !held {
				return true
			}
			document, err := input.Segment.DocumentAt(ordinal)
			if err != nil {
				failure = err
				return false
			}
			removal, err := p.carriedText(merged, document, analysed, true)
			if err != nil {
				failure = err
				return false
			}
			carried = append(carried, carriedTombstone{ordinal: target, text: removal})
			return true
		})
		if failure != nil {
			return false, failure
		}
	}
	p.pair.publish([]operation{{kind: swapSegments, dropped: segments, segment: merged, carried: carried}})
	return true, nil
}
