package vector

import (
	"context"
	"encoding/binary"
	"math"
	"slices"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

type coldHeap struct {
	numbers   []int
	distances []float64
}

func (h *coldHeap) push(number int, distance float64) {
	at := len(h.numbers)
	h.numbers = append(h.numbers, number)
	h.distances = append(h.distances, distance)
	for at > 0 {
		parent := (at - 1) >> 1
		if h.distances[parent] <= distance {
			break
		}
		h.numbers[at] = h.numbers[parent]
		h.distances[at] = h.distances[parent]
		at = parent
	}
	h.numbers[at] = number
	h.distances[at] = distance
}

func (h *coldHeap) pop() (int, float64, bool) {
	size := len(h.numbers)
	if size == 0 {
		return 0, 0, false
	}
	topNumber, topDistance := h.numbers[0], h.distances[0]
	number, distance := h.numbers[size-1], h.distances[size-1]
	h.numbers = h.numbers[:size-1]
	h.distances = h.distances[:size-1]
	remaining := size - 1
	if remaining == 0 {
		return topNumber, topDistance, true
	}
	at := 0
	for {
		child := 2*at + 1
		if child >= remaining {
			break
		}
		if child+1 < remaining && h.distances[child+1] < h.distances[child] {
			child++
		}
		if h.distances[child] >= distance {
			break
		}
		h.numbers[at] = h.numbers[child]
		h.distances[at] = h.distances[child]
		at = child
	}
	h.numbers[at] = number
	h.distances[at] = distance
	return topNumber, topDistance, true
}

func (h *coldHeap) negatedTop() float64 {
	if len(h.distances) == 0 {
		return math.Inf(1)
	}
	return -h.distances[0]
}

type coldWalk struct {
	field      *coldGraphField
	query      []float32
	metric     model.VectorMetric
	magnitude  float64
	visited    []uint8
	vector     []float32
	rowBytes   []byte
	codes      *coldQuery
	admits     func(docID string) bool
	excluded   map[int]struct{}
	acceptance map[int]bool
	failure    error
}

type coldQuery struct {
	code        osqQueryCode
	staged      []byte
	record      []byte
	codeBytes   int
	queryBits   uint32
	centroidDot float64
}

func (w *coldWalk) fail(err error) float64 {
	if w.failure == nil {
		w.failure = err
	}
	return math.Inf(1)
}

func (w *coldWalk) fullDistance(number int) float64 {
	if err := w.field.readVector(number, w.vector, w.rowBytes); err != nil {
		return w.fail(err)
	}
	switch w.metric {
	case model.MetricDotProduct:
		return -dotOf(w.query, w.vector)
	case model.MetricEuclidean:
		return math.Sqrt(squaredDistanceOf(w.query, w.vector))
	}
	vectorMagnitude := magnitudeOf(w.vector)
	if w.magnitude == 0 || vectorMagnitude == 0 {
		return 1
	}
	return 1 - dotOf(w.query, w.vector)/float64(w.magnitude*vectorMagnitude)
}

func (w *coldWalk) codeDistance(number int) float64 {
	at := w.field.fileOfNumber(number)
	file := w.field.input.Files[at]
	if file.Records == nil {
		return math.Inf(1)
	}
	codes := w.codes
	if err := file.Records.Read(int64(number-w.field.firstNumbers[at])*int64(len(codes.record)), codes.record); err != nil {
		return w.fail(err)
	}
	codeBits := w.field.input.CodeBits
	products := osqQueryProducts(codeBits, w.field.input.Dimension, codes.codeBytes, codes.record, codes.staged)
	trailer := readOsqTrailer(codes.record, codes.codeBytes)
	return osqEstimatedDistance(products, trailer, codeBits, codes.code, codes.queryBits, w.field.input.Dimension,
		codes.centroidDot, w.metric)
}

func (w *coldWalk) distanceOf(number int) float64 {
	if w.codes != nil {
		return w.codeDistance(number)
	}
	return w.fullDistance(number)
}

func (w *coldWalk) isAccepted(number int) bool {
	if _, removed := w.excluded[number]; removed || w.field.isDeadNumber(number) {
		return false
	}
	if w.admits == nil {
		return true
	}
	if held, known := w.acceptance[number]; known {
		return held
	}
	id, err := w.field.idAt(number)
	if err != nil {
		w.fail(err)
		return false
	}
	accepted := w.admits(id)
	w.acceptance[number] = accepted
	return accepted
}

func (w *coldWalk) neighbours(number int, layer int) ([]byte, error) {
	part := number / coldGraphPartVectors
	offset := number % coldGraphPartVectors
	if part >= len(w.field.input.Parts) || offset+1 >= len(w.field.input.Parts[part].NodeOffsets) {
		return nil, coldReadFailed("Vector "+strconv.Itoa(number)+" holds no neighbour lists", "")
	}
	held := w.field.input.Parts[part]
	start, end := held.NodeOffsets[offset], held.NodeOffsets[offset+1]
	data, err := held.Neighbours.BytesAt(int64(start), int64(end)-int64(start))
	if err != nil {
		return nil, err
	}
	cursor := 0
	for current := 0; ; current++ {
		if cursor+coldNeighbourEntryBytes > len(data) {
			return nil, coldReadFailed("The neighbour lists of vector "+strconv.Itoa(number)+" end inside a list", "")
		}
		count := int(binary.LittleEndian.Uint32(data[cursor:]))
		if count > (len(data)-cursor-coldNeighbourEntryBytes)/coldNeighbourEntryBytes {
			return nil, coldReadFailed("The neighbour list of vector "+strconv.Itoa(number)+" runs past its node", "")
		}
		if current == layer {
			from := cursor + coldNeighbourEntryBytes
			return data[from : from+count*coldNeighbourEntryBytes], nil
		}
		cursor += coldNeighbourEntryBytes + count*coldNeighbourEntryBytes
	}
}

func (w *coldWalk) walkLayer(ctx context.Context, entries []int, ef int, layer int, excludes bool) *coldHeap {
	clear(w.visited)
	frontier, found := &coldHeap{}, &coldHeap{}
	take := func(number int, distance float64) {
		found.push(number, -distance)
		if len(found.numbers) > ef {
			found.pop()
		}
	}
	for _, entry := range entries {
		if entry < 0 || entry >= len(w.visited) || w.visited[entry] == 1 {
			continue
		}
		w.visited[entry] = 1
		if w.field.topLayerOf(entry) < layer {
			continue
		}
		distance := w.distanceOf(entry)
		if math.IsInf(distance, 1) {
			continue
		}
		frontier.push(entry, distance)
		if excludes && !w.isAccepted(entry) {
			continue
		}
		take(entry, distance)
	}
	furthest := found.negatedTop()
	for w.failure == nil {
		if err := ctx.Err(); err != nil {
			w.fail(err)
			break
		}
		next, nextDistance, held := frontier.pop()
		if !held || (nextDistance > furthest && len(found.numbers) >= ef) {
			break
		}
		list, err := w.neighbours(next, layer)
		if err != nil {
			w.fail(err)
			break
		}
		for at := 0; at < len(list); at += coldNeighbourEntryBytes {
			neighbour := int(binary.LittleEndian.Uint32(list[at:]))
			if neighbour >= w.field.total || w.visited[neighbour] == 1 {
				continue
			}
			w.visited[neighbour] = 1
			if w.field.topLayerOf(neighbour) < layer {
				continue
			}
			distance := w.distanceOf(neighbour)
			if math.IsInf(distance, 1) {
				continue
			}
			if distance < furthest || len(found.numbers) < ef {
				frontier.push(neighbour, distance)
				if excludes && !w.isAccepted(neighbour) {
					continue
				}
				take(neighbour, distance)
				furthest = found.negatedTop()
			}
		}
	}
	return found
}

func nearestFirst(found *coldHeap) ([]int, []float64) {
	var numbers []int
	var distances []float64
	for {
		number, distance, held := found.pop()
		if !held {
			break
		}
		numbers = append(numbers, number)
		distances = append(distances, -distance)
	}
	slices.Reverse(numbers)
	slices.Reverse(distances)
	return numbers, distances
}

func (c *coldGraphField) entryNumber() int {
	if entry := c.input.EntryPoint; entry >= 0 && c.topLayerOf(entry) >= 0 {
		return entry
	}
	best, bestTop := coldWalkNoEntry, -1
	for number := range c.total {
		if top := c.topLayerOf(number); top > bestTop {
			best, bestTop = number, top
		}
	}
	return best
}

func (c *coldGraphField) queryCodes(query []float32, metric model.VectorMetric) *coldQuery {
	if c.input.CodeBits == 0 || c.input.Centroid == nil {
		return nil
	}
	codeBits := c.input.CodeBits
	queryBits := osqQueryBitsOf(codeBits)
	staged := make([]byte, osqStagedQueryBytes(c.input.Dimension, codeBits))
	code := osqQuantizeQuery(query, c.input.Centroid, queryBits, metric)
	stageQueryLevels(code.levels, codeBits, staged)
	centroidDot := 0.0
	for _, component := range c.input.Centroid {
		value := float64(component)
		centroidDot += float64(value * value)
	}
	return &coldQuery{code: code, staged: staged, record: make([]byte, osqRecordBytes(c.input.Dimension, codeBits)),
		codeBytes: osqCodeBytes(c.input.Dimension, codeBits), queryBits: queryBits, centroidDot: centroidDot}
}

type coldScored struct {
	number int
	score  float64
}

func reachingTheTop(scored []coldScored, k int) []coldScored {
	if k <= 0 || len(scored) <= k {
		return scored
	}
	slices.SortStableFunc(scored, func(left, right coldScored) int { return compareScoresDescending(left.score, right.score) })
	lowestKept := scored[k-1].score
	end := k
	for end < len(scored) && scored[end].score == lowestKept {
		end++
	}
	return scored[:end]
}
