package vector

import (
	"context"
	"math"
	"slices"
)

func (c *coldGraphField) walk(ctx context.Context, query []float32, k int, options SearchOptions,
	admits func(docID string) bool, excluded map[int]struct{}) ([]ScoredResult, error) {
	entry := c.entryNumber()
	if entry == coldWalkNoEntry {
		return []ScoredResult{}, nil
	}
	walk := &coldWalk{field: c, query: query, metric: options.Metric, magnitude: magnitudeOf(query),
		visited: make([]uint8, c.total), vector: make([]float32, c.input.Dimension),
		rowBytes: make([]byte, c.input.Dimension*coldVectorComponentBytes), codes: c.queryCodes(query, options.Metric),
		admits: admits, excluded: excluded, acceptance: map[int]bool{}}
	window := k
	if options.RescoreWindow > 0 {
		window = options.RescoreWindow
	}
	depth := window
	if walk.codes != nil {
		depth = RescoreDepth(c.input.CodeBits, c.input.Dimension, window, options.Oversample)
	}
	ef := defaultEfSearchFor(c.input.Dimension, window)
	if options.EfSearch > 0 {
		ef = options.EfSearch
	}
	ef = max(ef, depth)
	current := entry
	for layer := min(c.input.MaxLayer, c.topLayerOf(entry)); layer >= 1; layer-- {
		numbers, _ := nearestFirst(walk.walkLayer(ctx, []int{current}, 1, layer, false))
		if walk.failure != nil {
			return nil, walk.failure
		}
		if len(numbers) > 0 {
			current = numbers[0]
		}
	}
	numbers, distances := nearestFirst(walk.walkLayer(ctx, []int{current}, ef, 0, true))
	if walk.failure != nil {
		return nil, walk.failure
	}
	rescores := walk.codes != nil
	rescoreUntil := 0
	if rescores {
		rescoreUntil = min(depth, len(numbers))
	}
	scored := make([]coldScored, 0, len(numbers))
	for at, number := range numbers {
		if rescores && at >= rescoreUntil && (options.RescoreWindow <= 0 || !math.IsInf(options.MinSimilarity, -1)) {
			break
		}
		distance := distances[at]
		if at < rescoreUntil {
			distance = walk.fullDistance(number)
			if walk.failure != nil {
				return nil, walk.failure
			}
		}
		score := toScore(distance, options.Metric)
		if score < options.MinSimilarity {
			continue
		}
		scored = append(scored, coldScored{number: number, score: score})
	}
	kept := reachingTheTop(scored, k)
	hits := make([]ScoredResult, 0, len(kept))
	for _, held := range kept {
		id, err := c.idAt(held.number)
		if err != nil {
			return nil, err
		}
		hits = append(hits, ScoredResult{DocID: id, Score: held.score})
	}
	slices.SortStableFunc(hits, highScoreFirst)
	return hits[:min(len(hits), max(k, 0))], nil
}
