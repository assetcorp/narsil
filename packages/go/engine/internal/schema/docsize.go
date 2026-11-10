package schema

import (
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"strconv"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

const (
	messagePackFloat64Bytes   = 9
	messagePackLongestLength  = 1 << 32
	timestamp32MaxSeconds     = 1<<32 - 1
	timestamp64MaxSeconds     = 1<<34 - 1
	timestamp32ExtensionBytes = 6
	timestamp64ExtensionBytes = 10
	timestamp96ExtensionBytes = 15
	float32VectorElementBytes = 4
)

type sizeWalk struct {
	vectorPaths  map[string]int
	integerBytes int64
	floatBytes   int64
	negativeZero bool
	unencodable  bool
	over         bool
}

func RequireDocumentWithinSizeLimit(document model.Document, parsed *Parsed) error {
	walk := &sizeWalk{}
	if parsed != nil {
		walk.vectorPaths = parsed.vectors
	}
	walk.value(document, "", true, 1)
	if walk.unencodable && !walk.over {
		return nil
	}
	total := walk.integerBytes
	if walk.negativeZero {
		total = walk.floatBytes
	}
	if !walk.over && total <= MaxDocumentBytes {
		return nil
	}
	return narsilerr.New(
		narsilerr.CodeDocValidationFailed,
		fmt.Sprintf("The document takes at least %d bytes as MessagePack, vector values included, but a document may take at most %d", total, MaxDocumentBytes),
		map[string]any{"bytes": total, "maximum": MaxDocumentBytes},
	)
}

func (w *sizeWalk) add(integerBytes, floatBytes int64) {
	w.integerBytes += integerBytes
	w.floatBytes += floatBytes
	if w.integerBytes > MaxDocumentBytes {
		w.over = true
	}
}

func (w *sizeWalk) addBoth(bytes int64) {
	w.add(bytes, bytes)
}

func (w *sizeWalk) stopped() bool {
	return w.over || w.unencodable
}

func lengthHeaderBytes(length int, shortLimit int, eightBitHeader bool) (int64, bool) {
	switch {
	case length < shortLimit:
		return 1, true
	case eightBitHeader && length < 1<<8:
		return 2, true
	case length < 1<<16:
		return 3, true
	case int64(length) < messagePackLongestLength:
		return 5, true
	default:
		return 0, false
	}
}

func binaryHeaderBytes(length int) (int64, bool) {
	switch {
	case length < 1<<8:
		return 2, true
	case length < 1<<16:
		return 3, true
	case int64(length) < messagePackLongestLength:
		return 5, true
	default:
		return 0, false
	}
}

func integerEncodingBytes(number float64) int64 {
	if number != math.Trunc(number) || math.Abs(number) > MaxSafeInteger {
		return messagePackFloat64Bytes
	}
	switch {
	case number >= 0 && number < 1<<7:
		return 1
	case number >= 0 && number < 1<<8:
		return 2
	case number >= 0 && number < 1<<16:
		return 3
	case number >= 0 && number < 1<<32:
		return 5
	case number >= 0:
		return messagePackFloat64Bytes
	case number >= -(1 << 5):
		return 1
	case number >= -(1 << 7):
		return 2
	case number >= -(1 << 15):
		return 3
	case number >= -(1 << 31):
		return 5
	default:
		return messagePackFloat64Bytes
	}
}

func timestampBytes(moment time.Time) int64 {
	seconds := moment.Unix()
	if seconds >= 0 && seconds <= timestamp64MaxSeconds {
		if moment.Nanosecond() == 0 && seconds <= timestamp32MaxSeconds {
			return timestamp32ExtensionBytes
		}
		return timestamp64ExtensionBytes
	}
	return timestamp96ExtensionBytes
}

func (w *sizeWalk) number(number float64) {
	if number == 0 && math.Signbit(number) {
		w.negativeZero = true
	}
	w.add(integerEncodingBytes(number), messagePackFloat64Bytes)
}

func (w *sizeWalk) text(length int) {
	header, encodable := lengthHeaderBytes(length, 32, true)
	if !encodable {
		w.unencodable = true
		return
	}
	w.addBoth(header + int64(length))
}

func (w *sizeWalk) binary(length int) {
	header, encodable := binaryHeaderBytes(length)
	if !encodable {
		w.unencodable = true
		return
	}
	w.addBoth(header + int64(length))
}

func (w *sizeWalk) container(length int) bool {
	header, encodable := lengthHeaderBytes(length, 16, false)
	if !encodable {
		w.unencodable = true
		return false
	}
	w.addBoth(header)
	return true
}

func (w *sizeWalk) value(value any, path string, mapPath bool, depth int) {
	if w.stopped() {
		return
	}
	if depth > MaxDocumentEncodingDepth {
		w.unencodable = true
		return
	}
	switch typed := value.(type) {
	case nil, bool:
		w.addBoth(1)
	case float64:
		w.number(typed)
	case string:
		w.text(len(typed))
	case json.Number:
		parsed, err := strconv.ParseFloat(string(typed), 64)
		if err != nil && !math.IsInf(parsed, 0) {
			w.unencodable = true
			return
		}
		w.number(parsed)
	case time.Time:
		w.addBoth(timestampBytes(typed))
	case []byte:
		if typed == nil {
			w.addBoth(1)
			return
		}
		w.binary(len(typed))
	case []float32:
		w.float32List(typed, path, mapPath, depth)
	case []any:
		if typed == nil {
			w.addBoth(1)
			return
		}
		if w.container(len(typed)) {
			for _, item := range typed {
				if w.stopped() {
					return
				}
				w.value(item, path, false, depth+1)
			}
		}
	case map[string]any:
		if typed == nil {
			w.addBoth(1)
			return
		}
		if w.container(len(typed)) {
			for key, item := range typed {
				if w.stopped() {
					return
				}
				w.text(len(key))
				w.value(item, joinPath(path, key), mapPath, depth+1)
			}
		}
	default:
		w.reflected(reflect.ValueOf(value), path, mapPath, depth)
	}
}

func (w *sizeWalk) float32List(values []float32, path string, mapPath bool, depth int) {
	if values == nil {
		w.addBoth(1)
		return
	}
	if _, isVector := w.vectorPaths[path]; isVector && mapPath {
		w.binary(len(values) * float32VectorElementBytes)
		return
	}
	if w.container(len(values)) {
		for _, item := range values {
			if w.stopped() {
				return
			}
			w.number(float64(item))
		}
	}
}

func (w *sizeWalk) reflected(reflected reflect.Value, path string, mapPath bool, depth int) {
	switch reflected.Kind() {
	case reflect.String:
		w.text(reflected.Len())
	case reflect.Bool:
		w.addBoth(1)
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		w.number(float64(reflected.Int()))
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr:
		w.number(float64(reflected.Uint()))
	case reflect.Float32, reflect.Float64:
		w.number(reflected.Float())
	case reflect.Slice, reflect.Array:
		if reflected.Kind() == reflect.Slice && reflected.IsNil() {
			w.addBoth(1)
			return
		}
		if reflected.Type().Elem().Kind() == reflect.Uint8 {
			w.binary(reflected.Len())
			return
		}
		if w.container(reflected.Len()) {
			for i := 0; i < reflected.Len() && !w.stopped(); i++ {
				w.value(reflected.Index(i).Interface(), path, false, depth+1)
			}
		}
	case reflect.Map:
		if reflected.Type().Key().Kind() != reflect.String {
			w.unencodable = true
			return
		}
		if reflected.IsNil() {
			w.addBoth(1)
			return
		}
		if w.container(reflected.Len()) {
			entries := reflected.MapRange()
			for entries.Next() && !w.stopped() {
				key := entries.Key().String()
				w.text(len(key))
				w.value(entries.Value().Interface(), joinPath(path, key), mapPath, depth+1)
			}
		}
	default:
		w.unencodable = true
	}
}
