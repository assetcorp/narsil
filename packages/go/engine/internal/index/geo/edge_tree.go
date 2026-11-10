package geo

import (
	"math"
	"slices"
)

type longitudeEdgeTree struct {
	from        []int32
	to          []int32
	low         []float64
	high        []float64
	subtreeHigh []float64
}

func previousVertex(at, count int) int {
	if at == 0 {
		return count - 1
	}
	return at - 1
}

func buildLongitudeEdgeTree(lons []float64) *longitudeEdgeTree {
	count := len(lons)
	edges := make([]int, 0, count)
	for at := range count {
		if lons[at] != lons[previousVertex(at, count)] {
			edges = append(edges, at)
		}
	}
	lowOf := func(at int) float64 { return math.Min(lons[at], lons[previousVertex(at, count)]) }
	slices.SortStableFunc(edges, func(left, right int) int {
		leftLow, rightLow := lowOf(left), lowOf(right)
		switch {
		case leftLow < rightLow:
			return -1
		case leftLow > rightLow:
			return 1
		}
		return 0
	})
	tree := &longitudeEdgeTree{
		from:        make([]int32, len(edges)),
		to:          make([]int32, len(edges)),
		low:         make([]float64, len(edges)),
		high:        make([]float64, len(edges)),
		subtreeHigh: make([]float64, len(edges)),
	}
	for at, vertex := range edges {
		previous := previousVertex(vertex, count)
		tree.from[at] = int32(vertex)
		tree.to[at] = int32(previous)
		tree.low[at] = math.Min(lons[vertex], lons[previous])
		tree.high[at] = math.Max(lons[vertex], lons[previous])
	}
	tree.fillSubtreeHigh(0, len(edges))
	return tree
}

func (tree *longitudeEdgeTree) fillSubtreeHigh(start, end int) float64 {
	if start >= end {
		return math.Inf(-1)
	}
	mid := int(uint(start+end) >> 1)
	highest := math.Max(tree.high[mid], math.Max(tree.fillSubtreeHigh(start, mid), tree.fillSubtreeHigh(mid+1, end)))
	tree.subtreeHigh[mid] = highest
	return highest
}

func (tree *longitudeEdgeTree) forEachEdgeSpanning(lon float64, visit func(from, to int32)) {
	tree.walk(0, len(tree.from), lon, visit)
}

func (tree *longitudeEdgeTree) walk(start, end int, lon float64, visit func(from, to int32)) {
	if start >= end {
		return
	}
	mid := int(uint(start+end) >> 1)
	if tree.subtreeHigh[mid] <= lon {
		return
	}
	tree.walk(start, mid, lon, visit)
	if tree.low[mid] > lon {
		return
	}
	if lon < tree.high[mid] {
		visit(tree.from[mid], tree.to[mid])
	}
	tree.walk(mid+1, end, lon, visit)
}
