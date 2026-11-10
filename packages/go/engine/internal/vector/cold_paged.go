package vector

import (
	"context"
	"errors"
	"strconv"
	"sync"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
)

type coldSearchScratch struct {
	cache    *core.PageCache
	ordinals []uint32
	scores   []float64
}

var coldSearchScratchPool sync.Pool

func acquireColdSearchScratch() (*coldSearchScratch, error) {
	scratch, _ := coldSearchScratchPool.Get().(*coldSearchScratch)
	if scratch == nil {
		cache, err := core.NewPageCache(coldPageCacheSlots)
		if err != nil {
			return nil, coreFailure("createPageCache", err)
		}
		scratch = &coldSearchScratch{cache: cache}
	}
	return scratch, nil
}

func (s *coldSearchScratch) outputFor(ef int) core.PagedVectorOutput {
	if cap(s.ordinals) < ef {
		s.ordinals = make([]uint32, ef)
		s.scores = make([]float64, ef)
	}
	return core.PagedVectorOutput{Ordinals: s.ordinals[:ef], Scores: s.scores[:ef]}
}

func pagedFieldOf(input ColdGraphInput, firstNumbers []int, total int) core.PagedVectorField {
	field := core.PagedVectorField{Dimension: uint32(input.Dimension), Total: uint32(total),
		MaxLayer: uint32(max(input.MaxLayer, 0))}
	if input.EntryPoint >= 0 && input.EntryPoint < total {
		field.EntryPoint = uint32(input.EntryPoint)
		field.HasEntryPoint = true
	}
	coded := input.CodeBits != 0 && input.Centroid != nil
	for at, file := range input.Files {
		coded = coded && file.RecordPages != nil
		field.Files = append(field.Files, core.PagedVectorFile{First: uint32(firstNumbers[at]),
			Count: uint32(file.Count), Dead: file.Dead, Vectors: file.VectorPages, Records: file.RecordPages})
	}
	if coded {
		field.Codes = &core.PagedVectorCodes{Bits: input.CodeBits, Centroid: input.Centroid}
	} else {
		for at := range field.Files {
			field.Files[at].Records = nil
		}
	}
	for at, part := range input.Parts {
		field.GraphParts = append(field.GraphParts, core.PagedGraphPart{First: uint32(at * coldGraphPartVectors),
			Count: uint32(len(part.Levels)), Levels: part.Levels, NodeOffsets: part.NodeOffsets,
			Neighbours: part.NeighbourPages})
	}
	return field
}

func bitsetWith(total int, numbers func(set func(number int))) []uint32 {
	words := make([]uint32, max((total+31)/32, 1))
	numbers(func(number int) {
		if number >= 0 && number < total {
			words[number/32] |= 1 << (uint(number) % 32)
		}
	})
	return words
}

func (c *coldGraphField) AcceptedNumbers(ctx context.Context, filter *Filter) ([]uint32, error) {
	if !filter.byPartitions {
		var failure error
		accepted := bitsetWith(c.total, func(set func(number int)) {
			for _, docID := range filter.docIDs {
				number, held, err := c.NumberOf(docID)
				if err != nil {
					failure = err
					return
				}
				if held {
					set(number)
				}
			}
		})
		return accepted, failure
	}
	return c.numbersInPartitions(ctx, filter)
}

func (c *coldGraphField) pageFailure(err error) error {
	var fault *core.PageError
	if !errors.As(err, &fault) {
		return coreFailure("searchPagedVectors", err)
	}
	file, section := c.faultedSection(fault.Fault)
	return PageFailure(fault, file, section)
}

func (c *coldGraphField) faultedSection(fault core.PageFault) (string, string) {
	for _, file := range c.input.Files {
		if file.VectorPages.File == nil || file.VectorPages.File.Identity() != fault.File {
			continue
		}
		if file.RecordPages != nil && file.RecordPages.Offset == fault.Section {
			return file.Key, "records"
		}
		if file.VectorPages.Offset == fault.Section {
			return file.Key, "vectors"
		}
		return file.Key, strconv.FormatUint(fault.Section, 10)
	}
	for at, part := range c.input.Parts {
		if part.NeighbourPages.File == nil || part.NeighbourPages.File.Identity() != fault.File {
			continue
		}
		if at+len(c.input.Files) < len(c.input.FilePaths) {
			return c.input.FilePaths[at+len(c.input.Files)], "neighbours"
		}
		return "", "neighbours"
	}
	return "", strconv.FormatUint(fault.Section, 10)
}

func (c *coldGraphField) searchRequest(query []float32, k int, options SearchOptions) core.PagedVectorRequest {
	window := k
	if options.RescoreWindow > 0 {
		window = options.RescoreWindow
	}
	depth := window
	if c.paged.Codes != nil {
		depth = RescoreDepth(c.input.CodeBits, c.input.Dimension, window, options.Oversample)
	}
	ef := defaultEfSearchFor(c.input.Dimension, window)
	if options.EfSearch > 0 {
		ef = options.EfSearch
	}
	return core.PagedVectorRequest{Query: query, K: uint32(k), Ef: uint32(max(ef, depth)), RescoreDepth: uint32(depth),
		ExplicitRescoreWindow: options.RescoreWindow > 0, MinSimilarity: options.MinSimilarity}
}

func (c *coldGraphField) Search(ctx context.Context, query []float32, k int, options SearchOptions,
	accepted []uint32, excluded map[int]struct{}) ([]ScoredResult, error) {
	if c.total == 0 || k <= 0 {
		return []ScoredResult{}, nil
	}
	request := c.searchRequest(query, k, options)
	request.Accepted, request.HasAccepted = accepted, accepted != nil
	if len(excluded) > 0 {
		request.Excluded = bitsetWith(c.total, func(set func(number int)) {
			for number := range excluded {
				set(number)
			}
		})
		request.HasExcluded = true
	}
	field := c.paged
	field.Metric, _ = nativeMetricOf(options.Metric)
	return c.searchPaged(ctx, &field, &request, k)
}

func (c *coldGraphField) searchPaged(ctx context.Context, field *core.PagedVectorField,
	request *core.PagedVectorRequest, k int) ([]ScoredResult, error) {
	scratch, err := acquireColdSearchScratch()
	if err != nil {
		return nil, err
	}
	workspace, err := core.AcquireWorkspace()
	if err != nil {
		coldSearchScratchPool.Put(scratch)
		return nil, coreFailure("workspaceCreate", err)
	}
	defer workspace.Release()
	defer coldSearchScratchPool.Put(scratch)
	deadline := core.MeterDeadline(ctx)
	meter, err := core.NewWorkMeter(core.NoWorkCap, deadline)
	if err != nil {
		return nil, coreFailure("createWorkMeter", err)
	}
	request.Meter = meter
	stopped := make(chan struct{})
	stopOnCancel := context.AfterFunc(ctx, func() {
		meter.Stop()
		close(stopped)
	})
	output := scratch.outputFor(int(request.Ef))
	count, err := workspace.SearchPagedVectors(scratch.cache, field, request, output)
	if !stopOnCancel() {
		<-stopped
	}
	meter.Free()
	if ctxErr := ctx.Err(); ctxErr != nil {
		return nil, ctxErr
	}
	if deadline != 0 && core.StatusOf(err) == core.StatusStopped {
		return nil, context.DeadlineExceeded
	}
	if err != nil {
		return nil, c.pageFailure(err)
	}
	hits := make([]ScoredResult, 0, count)
	for at := range count {
		id, err := c.idAt(int(output.Ordinals[at]))
		if err != nil {
			return nil, err
		}
		hits = append(hits, ScoredResult{DocID: id, Score: output.Scores[at]})
	}
	orderTiedScoresByDocumentID(hits)
	return hits[:min(len(hits), k)], nil
}
