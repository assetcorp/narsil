package form

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
)

const schemaKey = "schema"

func SchemaKeyOrder(payload []byte) []string {
	decoder := codec.NewDecoder(payload, codec.DecodeOptions{})
	count, err := decoder.ReadMapHeader()
	if err != nil {
		return nil
	}
	var order []string
	for range count {
		key, err := decoder.ReadString()
		if err != nil {
			return nil
		}
		if key != schemaKey {
			if decoder.Skip() != nil {
				return nil
			}
			continue
		}
		value, err := decoder.ReadValueAsJavaScript()
		entries, isMap := value.(codec.OrderedMap)
		if err != nil || !isMap {
			return nil
		}
		order = make([]string, len(entries))
		for at, entry := range entries {
			order[at] = entry.Key
		}
	}
	return order
}

func SchemaEntries(schema map[string]string, order []string) codec.OrderedMap {
	entries := make(codec.OrderedMap, 0, len(schema))
	placed := make(map[string]struct{}, len(schema))
	for _, path := range order {
		typeName, declared := schema[path]
		if _, done := placed[path]; !declared || done {
			continue
		}
		placed[path] = struct{}{}
		entries = append(entries, codec.MapEntry{Key: path, Value: typeName})
	}
	remaining := make(map[string]any, len(schema)-len(placed))
	for path, typeName := range schema {
		if _, done := placed[path]; !done {
			remaining[path] = typeName
		}
	}
	for _, path := range codec.ObjectKeyOrder(remaining) {
		entries = append(entries, codec.MapEntry{Key: path, Value: schema[path]})
	}
	return codec.InJavaScriptPropertyOrder(entries)
}
