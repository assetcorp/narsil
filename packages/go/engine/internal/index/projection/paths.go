package projection

import (
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

type PathRead struct {
	Found bool
	Value any
}

func ReadPath(document model.Document, path []string) PathRead {
	var current any = map[string]any(document)
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
	case map[string]any:
		value, found := typed[key]
		return value, found
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
	switch value.(type) {
	case map[string]any, []byte, []float32, time.Time:
		return true
	}
	return false
}

func recordCopy(record any) map[string]any {
	switch typed := record.(type) {
	case map[string]any:
		copied := make(map[string]any, len(typed))
		for key, value := range typed {
			copied[key] = value
		}
		return copied
	case []byte:
		copied := make(map[string]any, len(typed))
		for index, element := range typed {
			copied[strconv.Itoa(index)] = float64(element)
		}
		return copied
	case []float32:
		copied := make(map[string]any, len(typed))
		for index, element := range typed {
			copied[strconv.Itoa(index)] = float64(element)
		}
		return copied
	}
	return map[string]any{}
}

func writePath(target map[string]any, path []string, value any) {
	current := target
	for _, segment := range path[:len(path)-1] {
		switch existing := current[segment].(type) {
		case map[string]any:
			current = existing
			continue
		case []byte, []float32, time.Time:
			return
		}
		created := map[string]any{}
		current[segment] = created
		current = created
	}
	current[path[len(path)-1]] = value
}

func writeFieldPath(target map[string]any, fieldPath string, value any) {
	segments := strings.Split(fieldPath, ".")
	current := target
	for _, segment := range segments[:len(segments)-1] {
		next, isMap := current[segment].(map[string]any)
		if !isMap {
			next = map[string]any{}
			current[segment] = next
		}
		current = next
	}
	current[segments[len(segments)-1]] = value
}

func cloneExcept(value any, path []string, exclude [][]string) any {
	if !excludeReachesBelow(exclude, path) || !isRecord(value) {
		return CopyValue(value)
	}
	entries, isMap := value.(map[string]any)
	if !isMap {
		entries = recordCopy(value)
	}
	kept := map[string]any{}
	for key, child := range entries {
		childPath := append(path[:len(path):len(path)], key)
		if coveredByAny(exclude, childPath) {
			continue
		}
		kept[key] = cloneExcept(child, childPath, exclude)
	}
	return kept
}
