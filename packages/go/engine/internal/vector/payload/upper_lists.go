package payload

import (
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

const (
	upperListsPerNodeFactor = 4
	upperListsAllowance     = 64
)

func RequireBoundedUpperLists(graphs GraphParts) error {
	for g, graph := range graphs.Graphs {
		if len(graph.Parts) == 0 {
			continue
		}
		if err := requireBoundedGraph(graph.Parts, graph.Parts[0].M, g, graphs.FieldName); err != nil {
			return err
		}
	}
	return nil
}

func requireBoundedGraph(parts []NumberedGraph, m int, g int, fieldName string) error {
	var nodes, upperLists int64
	for _, part := range parts {
		for _, level := range part.Levels {
			if level == 0 {
				continue
			}
			nodes++
			upperLists += int64(level) - 1
		}
	}
	spread := int64(m) - 1
	if upperLists*spread <= upperListsPerNodeFactor*nodes+upperListsAllowance*spread {
		return nil
	}
	limit := upperListsPerNodeFactor*nodes/spread + upperListsAllowance
	return narsilerr.New(narsilerr.CodePersistenceLoadFailed,
		"Graph "+strconv.Itoa(g)+" of the vector graph parts of field "+strconv.Quote(fieldName)+" holds "+
			strconv.FormatInt(upperLists, 10)+" upper-layer lists over "+strconv.FormatInt(nodes, 10)+
			" nodes, while a graph of that many nodes at m "+strconv.Itoa(m)+" holds at most "+strconv.FormatInt(limit, 10),
		map[string]any{"upperLists": upperLists, "nodes": nodes, "m": m, "limit": limit})
}
