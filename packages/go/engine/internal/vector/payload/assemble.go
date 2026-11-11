package payload

import (
	"encoding/binary"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

func sameGraphHeader(a NumberedGraph, b NumberedGraph) bool {
	return a.EntryPoint == b.EntryPoint && a.MaxLayer == b.MaxLayer && a.M == b.M &&
		a.EfConstruction == b.EfConstruction && a.Metric == b.Metric &&
		a.ShuffledBuildCount == b.ShuffledBuildCount && a.CalibratedMeanLength == b.CalibratedMeanLength
}

func requireOneGraphPerVector(part GraphPart, index int) error {
	if len(part.Graphs) < 2 {
		return nil
	}
	held := make([]bool, GraphPartVectors)
	for _, graph := range part.Graphs {
		for at, level := range graph.Levels {
			if level == 0 || at >= GraphPartVectors {
				continue
			}
			if held[at] {
				vector := index*GraphPartVectors + at
				return invalid(graphPartName, "part "+strconv.Itoa(index)+" gives vector "+strconv.Itoa(vector)+
					" a node in two graphs", map[string]any{"part": index, "vector": vector})
			}
			held[at] = true
		}
	}
	return nil
}

func AssembleGraphParts(parts []GraphPart) (GraphParts, error) {
	if len(parts) == 0 {
		return GraphParts{}, invalid(graphPartName, "a field that holds a graph must have at least one part", nil)
	}
	first := parts[0]
	lists := make([][]NumberedGraph, len(first.Graphs))
	for index, part := range parts {
		isLast := index == len(parts)-1
		if part.FieldName != first.FieldName || len(part.Graphs) != len(first.Graphs) {
			return GraphParts{}, invalid(graphPartName, "part "+strconv.Itoa(index)+" lists other graphs than part 0",
				map[string]any{"part": index})
		}
		for g, graph := range part.Graphs {
			if !sameGraphHeader(graph, first.Graphs[g]) {
				return GraphParts{}, invalid(graphPartName, "part "+strconv.Itoa(index)+" gives graph "+strconv.Itoa(g)+
					" other headers", map[string]any{"part": index})
			}
			levels := len(graph.Levels)
			fits := levels == GraphPartVectors
			if isLast {
				fits = levels >= 1 && levels <= GraphPartVectors
			}
			if !fits {
				return GraphParts{}, invalid(graphPartName, "part "+strconv.Itoa(index)+" gives graph "+strconv.Itoa(g)+
					" "+strconv.Itoa(levels)+" bytes of levels", map[string]any{"part": index, "levels": levels})
			}
			lists[g] = append(lists[g], graph)
		}
		if err := requireOneGraphPerVector(part, index); err != nil {
			return GraphParts{}, err
		}
	}
	assembled := GraphParts{FieldName: first.FieldName, Graphs: make([]NumberedGraphParts, len(lists))}
	for g, list := range lists {
		assembled.Graphs[g] = NumberedGraphParts{PartSize: GraphPartVectors, Parts: list}
	}
	if err := RequireBoundedUpperLists(assembled); err != nil {
		return GraphParts{}, err
	}
	return assembled, nil
}

func GraphPartsOfEarlier(part GraphPart) GraphParts {
	assembled := GraphParts{FieldName: part.FieldName, Graphs: make([]NumberedGraphParts, len(part.Graphs))}
	for g, graph := range part.Graphs {
		assembled.Graphs[g] = NumberedGraphParts{PartSize: max(len(graph.Levels), 1), Parts: []NumberedGraph{graph}}
	}
	return assembled
}

func endsInsideAList() error {
	return invalid(graphName, "neighbours ends inside a list", nil)
}

func NeighbourValue(neighbours []byte, index int) uint32 {
	return binary.LittleEndian.Uint32(neighbours[index*uint32Bytes:])
}

func RequireWholeNeighbourLists(graph NumberedGraph) error {
	if len(graph.Neighbours)%uint32Bytes != 0 {
		return endsInsideAList()
	}
	values := len(graph.Neighbours) / uint32Bytes
	cursor := 0
	for _, level := range graph.Levels {
		for range int(level) {
			if cursor >= values {
				return endsInsideAList()
			}
			count := int(NeighbourValue(graph.Neighbours, cursor))
			if count > values-cursor-1 {
				return endsInsideAList()
			}
			cursor += count + 1
		}
	}
	return nil
}

func GraphWithoutNodes(graph NumberedGraph, firstNumber int, numbers map[int]struct{}) NumberedGraph {
	values := len(graph.Neighbours) / uint32Bytes
	levels := append([]byte(nil), graph.Levels...)
	kept := make([]byte, 0, len(graph.Neighbours))
	cursor := 0
	for at, level := range graph.Levels {
		start := cursor
		for range int(level) {
			if cursor >= values {
				break
			}
			cursor += int(NeighbourValue(graph.Neighbours, cursor)) + 1
		}
		cursor = min(cursor, values)
		if _, gone := numbers[firstNumber+at]; gone {
			levels[at] = 0
			continue
		}
		kept = append(kept, graph.Neighbours[start*uint32Bytes:cursor*uint32Bytes]...)
	}
	stripped := graph
	stripped.Levels = levels
	stripped.Neighbours = kept
	if entry, set := graph.EntryPoint.Get(); set {
		if _, gone := numbers[int(entry)]; gone {
			stripped.EntryPoint = model.Optional[uint32]{}
		}
	}
	return stripped
}
