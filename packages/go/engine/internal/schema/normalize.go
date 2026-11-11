package schema

import (
	"encoding/json"
	"math"
	"reflect"
	"strconv"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type normaliser struct {
	vectorPaths map[string]int
	nodes       int
	reencoded   int
	exhausted   bool
}

func NormalizeDocument(document *model.Document, parsed *Parsed) (*model.Document, error) {
	if document == nil {
		return nil, documentRequired()
	}
	run := &normaliser{}
	if parsed != nil {
		run.vectorPaths = parsed.vectors
	}
	normalised := run.document(document, "", true, 0)
	if run.exhausted {
		return nil, narsilerr.New(
			narsilerr.CodeDocValidationFailed,
			"The document holds more values than a document of at most 16777216 bytes as MessagePack can hold",
			map[string]any{"maximum": MaxDocumentBytes},
		)
	}
	return normalised, nil
}

func (n *normaliser) visit() bool {
	n.nodes++
	if n.nodes > MaxDocumentNodes {
		n.exhausted = true
	}
	return !n.exhausted
}

func (n *normaliser) isVectorPath(path string, mapPath bool) bool {
	if !mapPath || n.vectorPaths == nil {
		return false
	}
	_, found := n.vectorPaths[path]
	return found
}

func (n *normaliser) document(source *model.Document, prefix string, mapPath bool, depth int) *model.Document {
	return codec.TransformDocument(source, func(key string, entry codec.HeldEntry) (any, bool) {
		if n.exhausted {
			return nil, false
		}
		before := n.reencoded
		normalised := n.value(entry.Value, joinPath(prefix, key), mapPath, depth+1)
		if entry.Stored != nil && n.reencoded == before {
			return nil, true
		}
		return normalised, false
	})
}

func (n *normaliser) sortedDocument(keys []string, valueOf func(key string) any, prefix string, mapPath bool, depth int) *model.Document {
	codec.SortObjectKeys(keys)
	normalised := codec.NewDocumentOfLength(len(keys))
	for _, key := range keys {
		if n.exhausted {
			break
		}
		codec.PutHeld(normalised, key, n.value(valueOf(key), joinPath(prefix, key), mapPath, depth+1))
	}
	return normalised
}

func (n *normaliser) value(value any, path string, mapPath bool, depth int) any {
	if !n.visit() {
		return nil
	}
	switch typed := value.(type) {
	case nil, bool, string, float64:
		return value
	case time.Time:
		truncated := typed.Truncate(time.Millisecond)
		if !truncated.Equal(typed) {
			n.reencoded++
		}
		return truncated
	case float32:
		return float64(typed)
	case int:
		return float64(typed)
	case int64:
		return float64(typed)
	case int32:
		return float64(typed)
	case uint32:
		return float64(typed)
	case uint64:
		return float64(typed)
	case json.Number:
		parsed, err := strconv.ParseFloat(string(typed), 64)
		if err != nil && !math.IsInf(parsed, 0) {
			return value
		}
		return parsed
	case []byte:
		if typed == nil {
			return nil
		}
		return append([]byte{}, typed...)
	case []float32:
		return n.float32List(typed, path, mapPath, depth)
	case []float64:
		return n.float64List(typed, path, mapPath, depth)
	case []any:
		if typed == nil {
			return nil
		}
		if depth >= MaxDocumentNestingDepth {
			return value
		}
		return n.list(len(typed), func(i int) any { return typed[i] }, path, mapPath, depth)
	case *model.Document:
		if typed == nil {
			return nil
		}
		if depth >= MaxDocumentNestingDepth {
			return value
		}
		return n.document(typed, path, mapPath, depth)
	case map[string]any:
		if typed == nil {
			return nil
		}
		if depth >= MaxDocumentNestingDepth {
			return value
		}
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		return n.sortedDocument(keys, func(key string) any { return typed[key] }, path, mapPath, depth)
	}
	return n.reflected(value, path, mapPath, depth)
}

func (n *normaliser) reflected(value any, path string, mapPath bool, depth int) any {
	reflected := reflect.ValueOf(value)
	switch reflected.Kind() {
	case reflect.String:
		return reflected.String()
	case reflect.Bool:
		return reflected.Bool()
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return float64(reflected.Int())
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr:
		return float64(reflected.Uint())
	case reflect.Float32, reflect.Float64:
		return reflected.Float()
	case reflect.Slice:
		if reflected.IsNil() {
			return nil
		}
		return n.reflectedList(reflected, value, path, mapPath, depth)
	case reflect.Array:
		return n.reflectedList(reflected, value, path, mapPath, depth)
	case reflect.Map:
		keyType := reflected.Type().Key()
		if keyType.Kind() != reflect.String {
			return value
		}
		if reflected.IsNil() {
			return nil
		}
		if depth >= MaxDocumentNestingDepth {
			return value
		}
		keys := make([]string, 0, reflected.Len())
		for _, key := range reflected.MapKeys() {
			keys = append(keys, key.String())
		}
		return n.sortedDocument(keys, func(key string) any {
			return reflected.MapIndex(reflect.ValueOf(key).Convert(keyType)).Interface()
		}, path, mapPath, depth)
	default:
		return value
	}
}

func (n *normaliser) reflectedList(reflected reflect.Value, value any, path string, mapPath bool, depth int) any {
	if reflected.Type().Elem().Kind() == reflect.Uint8 {
		bytes := make([]byte, reflected.Len())
		reflect.Copy(reflect.ValueOf(bytes), reflected)
		return bytes
	}
	if depth >= MaxDocumentNestingDepth {
		return value
	}
	return n.list(reflected.Len(), func(i int) any { return reflected.Index(i).Interface() }, path, mapPath, depth)
}

func (n *normaliser) list(length int, element func(int) any, path string, mapPath bool, depth int) any {
	items := make([]any, 0, length)
	for i := 0; i < length && !n.exhausted; i++ {
		items = append(items, n.value(element(i), path, false, depth+1))
	}
	if n.isVectorPath(path, mapPath) {
		if vector, extractable := vectorOfNumbers(items); extractable {
			n.reencoded++
			return vector
		}
	}
	return items
}

func (n *normaliser) float32List(values []float32, path string, mapPath bool, depth int) any {
	if values == nil {
		return nil
	}
	if depth >= MaxDocumentNestingDepth {
		return values
	}
	if n.isVectorPath(path, mapPath) && finiteFloat32s(values) {
		n.nodes += len(values)
		if n.nodes > MaxDocumentNodes {
			n.exhausted = true
			return nil
		}
		return append([]float32{}, values...)
	}
	return n.list(len(values), func(i int) any { return float64(values[i]) }, path, mapPath, depth)
}

func (n *normaliser) float64List(values []float64, path string, mapPath bool, depth int) any {
	if values == nil {
		return nil
	}
	if depth >= MaxDocumentNestingDepth {
		return values
	}
	return n.list(len(values), func(i int) any { return values[i] }, path, mapPath, depth)
}

func vectorOfNumbers(items []any) ([]float32, bool) {
	vector := make([]float32, len(items))
	for i, item := range items {
		number, isNumber := item.(float64)
		if !isNumber || !Float32Representable(number) {
			return nil, false
		}
		vector[i] = float32(number)
	}
	return vector, true
}

func finiteFloat32s(values []float32) bool {
	for _, value := range values {
		widened := float64(value)
		if math.IsNaN(widened) || math.IsInf(widened, 0) {
			return false
		}
	}
	return true
}

func textOf(value any) (string, bool) {
	if text, isText := value.(string); isText {
		return text, true
	}
	if value == nil {
		return "", false
	}
	reflected := reflect.ValueOf(value)
	if reflected.Kind() == reflect.String {
		return reflected.String(), true
	}
	return "", false
}
