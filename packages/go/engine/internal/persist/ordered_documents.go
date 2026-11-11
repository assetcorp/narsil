package persist

import (
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

var vectorFieldType = regexp.MustCompile(`^vector\[\d+]$`)

func storedEntries(encoded []byte) (codec.OrderedMap, error) {
	decoded, err := codec.UnmarshalAsJavaScript(encoded, codec.DecodeOptions{ErrorCode: narsilerr.CodePersistenceLoadFailed})
	if err != nil {
		return nil, err
	}
	entries, isMap := decoded.(codec.OrderedMap)
	if !isMap {
		return nil, narsilerr.New(narsilerr.CodePersistenceLoadFailed,
			"A stored document decodes to something other than a map", nil)
	}
	return entries, nil
}

func entryPosition(entries codec.OrderedMap, key string) int {
	for position := range entries {
		if entries[position].Key == key {
			return position
		}
	}
	return -1
}

func keepsItsProperties(value any) bool {
	switch value.(type) {
	case []any, []byte, time.Time, codec.InvalidDate, codec.Extension:
		return true
	}
	return false
}

func withNestedValue(entries codec.OrderedMap, segments []string, value any) codec.OrderedMap {
	key := segments[0]
	position := entryPosition(entries, key)
	if len(segments) > 1 {
		var nested codec.OrderedMap
		if position >= 0 {
			held, isObject := entries[position].Value.(codec.OrderedMap)
			if !isObject && keepsItsProperties(entries[position].Value) {
				return entries
			}
			nested = held
		}
		value = withNestedValue(nested, segments[1:], value)
	}
	copied := make(codec.OrderedMap, len(entries), len(entries)+1)
	copy(copied, entries)
	if position >= 0 {
		copied[position].Value = value
		return copied
	}
	return codec.InJavaScriptPropertyOrder(append(copied, codec.MapEntry{Key: key, Value: value}))
}

func withoutNestedValue(entries codec.OrderedMap, segments []string) codec.OrderedMap {
	position := entryPosition(entries, segments[0])
	if position < 0 {
		return entries
	}
	copied := make(codec.OrderedMap, len(entries))
	copy(copied, entries)
	if len(segments) == 1 {
		return append(copied[:position], copied[position+1:]...)
	}
	nested, isObject := entries[position].Value.(codec.OrderedMap)
	if !isObject {
		return entries
	}
	copied[position].Value = withoutNestedValue(nested, segments[1:])
	return copied
}

func withoutVectorFields(entries codec.OrderedMap, fieldSchema map[string]string) codec.OrderedMap {
	paths := make([]string, 0, len(fieldSchema))
	for path, fieldType := range fieldSchema {
		if vectorFieldType.MatchString(fieldType) {
			paths = append(paths, path)
		}
	}
	sort.Strings(paths)
	for _, path := range paths {
		entries = withoutNestedValue(entries, strings.Split(path, "."))
	}
	return entries
}
