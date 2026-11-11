package schema

import (
	"fmt"
	"sort"
	"strings"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

func extractVectors(document *model.Document, parsed *Parsed) map[string][]float32 {
	extracted := map[string][]float32{}
	if parsed == nil {
		return extracted
	}
	for path := range parsed.vectors {
		segments := strings.Split(path, ".")
		holder := document
		for _, segment := range segments[:len(segments)-1] {
			next, _ := codec.HeldValue(holder, segment)
			nested, isDocument := next.(*model.Document)
			if !isDocument {
				holder = nil
				break
			}
			holder = nested
		}
		if holder == nil {
			continue
		}
		leaf := segments[len(segments)-1]
		held, _ := codec.HeldValue(holder, leaf)
		if vector, isVector := held.([]float32); isVector {
			extracted[path] = vector
			holder.Delete(leaf)
		}
	}
	return extracted
}

func ValidateVectorDimensions(vectors map[string][]float32, parsed *Parsed) error {
	if parsed == nil {
		return nil
	}
	paths := make([]string, 0, len(vectors))
	for path := range vectors {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	for _, path := range paths {
		expected, declared := parsed.vectors[path]
		if !declared || len(vectors[path]) == expected {
			continue
		}
		return narsilerr.New(
			narsilerr.CodeVectorDimensionMismatch,
			fmt.Sprintf("Vector dimension mismatch for field %q: expected %d, got %d", path, expected, len(vectors[path])),
			map[string]any{"field": path, "expected": expected, "received": len(vectors[path])},
		)
	}
	return nil
}
