package projection

import (
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

type PathRead struct {
	Found bool
	Value any
}

func ReadPath(document *model.Document, path []string) PathRead {
	var current any = document
	for _, segment := range path {
		next, found := ownValue(current, segment)
		if !found {
			return PathRead{}
		}
		current = next
	}
	return PathRead{Found: true, Value: current}
}

func isPrototypePollutionKey(segment string) bool {
	switch segment {
	case "__proto__", "constructor", "prototype":
		return true
	}
	return false
}

func splitFieldPath(path string) []string {
	segments := []string{}
	for _, segment := range strings.Split(path, ".") {
		if segment != "" {
			segments = append(segments, segment)
		}
	}
	return segments
}

func splitPaths(paths []string) [][]string {
	split := [][]string{}
	for _, path := range paths {
		segments := splitFieldPath(path)
		if len(segments) == 0 || slices.ContainsFunc(segments, isPrototypePollutionKey) {
			continue
		}
		split = append(split, segments)
	}
	return split
}

func overlaps(left, right []string) bool {
	shared := min(len(left), len(right))
	for position := range shared {
		if left[position] != right[position] {
			return false
		}
	}
	return true
}

func covers(outer, inner []string) bool {
	if len(outer) > len(inner) {
		return false
	}
	for position, segment := range outer {
		if segment != inner[position] {
			return false
		}
	}
	return true
}

func coveredByAny(paths [][]string, path []string) bool {
	for _, outer := range paths {
		if covers(outer, path) {
			return true
		}
	}
	return false
}

func excludeReachesBelow(exclude [][]string, path []string) bool {
	for _, excluded := range exclude {
		if len(excluded) > len(path) && covers(path, excluded) {
			return true
		}
	}
	return false
}

func typedArrayIndex(key string, length int) (int, bool) {
	if key == "" || (len(key) > 1 && key[0] == '0') {
		return 0, false
	}
	for position := range len(key) {
		if key[position] < '0' || key[position] > '9' {
			return 0, false
		}
	}
	index, err := strconv.Atoi(key)
	if err != nil || index >= length {
		return 0, false
	}
	return index, true
}

func ownValue(container any, key string) (any, bool) {
	switch typed := container.(type) {
	case *model.Document:
		return codec.HeldValue(typed, key)
	case []byte:
		if index, found := typedArrayIndex(key, len(typed)); found {
			return float64(typed[index]), true
		}
	case []float32:
		if index, found := typedArrayIndex(key, len(typed)); found {
			return float64(typed[index]), true
		}
	}
	return nil, false
}

func isRecord(value any) bool {
	switch typed := value.(type) {
	case *model.Document:
		return typed != nil
	case []byte, []float32, time.Time:
		return true
	}
	return false
}

func indexedRecord[E byte | float32](elements []E) *model.Document {
	copied := codec.NewDocumentOfLength(len(elements))
	for index, element := range elements {
		codec.PutHeld(copied, strconv.Itoa(index), float64(element))
	}
	return copied
}

func recordCopy(record any) *model.Document {
	switch typed := record.(type) {
	case *model.Document:
		return shallowCopy(typed)
	case []byte:
		return indexedRecord(typed)
	case []float32:
		return indexedRecord(typed)
	}
	return model.NewDocument()
}

func writePath(target *model.Document, path []string, value any) {
	current := target
	for _, segment := range path[:len(path)-1] {
		existing, _ := codec.HeldValue(current, segment)
		switch typed := existing.(type) {
		case *model.Document:
			if typed != nil {
				current = typed
				continue
			}
		case []byte, []float32, time.Time:
			return
		}
		created := model.NewDocument()
		codec.PutHeld(current, segment, created)
		current = created
	}
	codec.PutHeld(current, path[len(path)-1], value)
}

func cloneExcept(value any, path []string, exclude [][]string) any {
	if !excludeReachesBelow(exclude, path) || !isRecord(value) {
		return CopyValue(value)
	}
	entries, isDocument := value.(*model.Document)
	if !isDocument {
		entries = recordCopy(value)
	}
	kept := codec.NewDocumentOfLength(entries.Len())
	for key, child := range codec.HeldEntries(entries) {
		childPath := append(path[:len(path):len(path)], key)
		if coveredByAny(exclude, childPath) {
			continue
		}
		codec.PutHeld(kept, key, cloneExcept(child, childPath, exclude))
	}
	return kept
}
