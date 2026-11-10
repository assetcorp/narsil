package corepartition

import (
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/segments"
)

type SegmentSize struct {
	Position      int
	LiveDocuments uint32
}

func (s *side) segmentSizes() []SegmentSize {
	sizes := make([]SegmentSize, len(s.frozen))
	for at, held := range s.frozen {
		sizes[at] = SegmentSize{Position: at, LiveDocuments: held.segment.documentCount() - held.state.Core.TombstoneCount[0]}
	}
	return sizes
}

type mergeSnapshot struct {
	inputs  []*frozenSegment
	sources []segments.Source
}

func (s *side) snapshotMerge(positions []int) mergeSnapshot {
	snapshot := mergeSnapshot{}
	for _, position := range positions {
		held := s.frozen[position]
		snapshot.inputs = append(snapshot.inputs, held.segment)
		snapshot.sources = append(snapshot.sources, segments.Source{Segment: len(snapshot.sources),
			Frozen: held.segment.frozen, State: held.state.Clone()})
	}
	return snapshot
}

func mergedOutput(result *segments.MergeResult, inputs []*frozenSegment) (*frozenSegment, error) {
	count := result.Frozen.DocumentCount()
	ids := make([]string, count)
	documents := make([][]byte, count)
	for at, input := range result.Segments {
		for ordinal, target := range result.Mappings[at] {
			if target == core.MergeDroppedOrdinal {
				continue
			}
			document, held, err := inputs[input].documentAt(uint32(ordinal))
			if err != nil {
				return nil, err
			}
			if !held {
				return nil, corruptedPartition("a merged document holds no stored value", uint32(ordinal))
			}
			ids[target], documents[target] = document.id, document.encoded
		}
	}
	return newFrozenSegment(result.Frozen, ids, documents), nil
}

func (p *Partition) Merge(sides *Sides, pick func(sizes []SegmentSize) []int) (bool, error) {
	p.merging.Lock()
	defer p.merging.Unlock()
	read, err := sides.Read()
	if err != nil {
		return false, err
	}
	held := p.sides[read.side]
	positions := pick(held.segmentSizes())
	if len(positions) < 2 {
		read.Release()
		return false, nil
	}
	snapshot := held.snapshotMerge(positions)
	read.Release()
	w, err := core.AcquireWorkspace()
	if err != nil {
		return false, err
	}
	results, err := segments.MergeAll(w, snapshot.sources)
	w.Release()
	if err != nil {
		return false, err
	}
	merged := &mergeResult{inputs: snapshot.inputs, results: results}
	for _, result := range results {
		output, err := mergedOutput(result, snapshot.inputs)
		if err != nil {
			return false, err
		}
		merged.output = append(merged.output, output)
	}
	installed := false
	err = sides.Write(func(write *Write) (err error) {
		pl := p.planner(write)
		defer pl.commit(&err)
		inputsHeld, err := pl.lateRemovals(merged, snapshot)
		if err != nil || !inputsHeld {
			return err
		}
		installed = true
		return pl.run(operation{kind: installMerge, merge: merged})
	})
	return installed, err
}

func (pl *planner) lateRemovals(merged *mergeResult, snapshot mergeSnapshot) (bool, error) {
	for input, segment := range merged.inputs {
		position := pl.side.frozenPosition(segment)
		if position < 0 {
			return false, nil
		}
		current := pl.side.frozen[position].state
		for ordinal := range segment.documentCount() {
			if !current.Tombstoned(ordinal) || snapshot.sources[input].State.Tombstoned(ordinal) {
				continue
			}
			text, err := pl.removedText(segment, ordinal)
			if err != nil {
				return false, err
			}
			merged.late = append(merged.late, lateRemoval{input: input, ordinal: ordinal, tokens: text.frozenTokens()})
		}
	}
	return true, nil
}

func (pl *planner) removedText(segment *frozenSegment, ordinal uint32) (preparedText, error) {
	stored, held, err := segment.documentAt(ordinal)
	if err != nil || !held {
		return preparedText{}, err
	}
	values, err := decodeStored(stored)
	if err != nil {
		return preparedText{}, err
	}
	analysed, err := pl.partition.analyser()
	if err != nil {
		return preparedText{}, err
	}
	return analysed.prepare(values)
}

func (s *side) frozenPosition(segment *frozenSegment) int {
	return slices.IndexFunc(s.frozen, func(held frozenSide) bool { return held.segment == segment })
}

func (s *side) installMerge(w *core.Workspace, merged *mergeResult) error {
	kept := make([]frozenSide, 0, len(s.frozen))
	for _, held := range s.frozen {
		if !slices.Contains(merged.inputs, held.segment) {
			kept = append(kept, held)
		}
	}
	late := make([]segments.LateRemoval, len(merged.late))
	for at, removal := range merged.late {
		late[at] = segments.LateRemoval{Segment: removal.input, Ordinal: removal.ordinal, Tokens: removal.tokens}
	}
	for at, result := range merged.results {
		state, err := result.Install(w, late)
		if err != nil {
			return err
		}
		kept = append(kept, newFrozenSide(merged.output[at], state))
	}
	s.frozen = kept
	return nil
}
