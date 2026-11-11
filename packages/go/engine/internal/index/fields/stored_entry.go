package fields

import (
	"math"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	narsiltext "github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type storedEntry struct {
	shape      byte
	kinds      []byte
	numbers    []float64
	textStart  []uint32
	textLength []uint32
	units      []uint16
	encoded    []byte
}

func (e *storedEntry) elements() uint64 {
	return uint64(len(e.kinds))
}

func (e *storedEntry) appendElement(path string, value any, index int, limits Limits) error {
	kind, number, start, length := storedKindNull, 0.0, uint32(0), uint32(0)
	switch typed := value.(type) {
	case nil:
	case bool:
		kind = storedKindFalse
		if typed {
			kind = storedKindTrue
		}
	case string:
		if err := checkText(path, typed, index); err != nil {
			return err
		}
		kind, start = storedKindString, uint32(len(e.units))
		e.units = narsiltext.AppendUTF16(e.units, typed)
		length = uint32(len(e.units)) - start
	default:
		if parsed, isNumber := numberOf(value); isNumber {
			kind, number = storedKindNumber, parsed
			if math.IsNaN(parsed) {
				number = codec.JavaScriptNaN()
			}
			break
		}
		kind, start = storedKindOther, uint32(len(e.encoded))
		if holdsForeignNaN(value, 0) {
			value = withJavaScriptNaN(value, 0)
		}
		encoded, err := codec.AppendValue(e.encoded, value, codec.EncodeOptions{
			ForceIntegerToFloat: codec.HoldsNegativeZero(value, 1),
			FromValues:          true,
			MaxDepth:            codec.MaxDocumentEncodingDepth,
			ErrorCode:           narsilerr.CodeDocValidationFailed,
		})
		if err != nil {
			return invalidValue(path, "cannot be encoded as MessagePack", map[string]any{"reason": err.Error()})
		}
		if uint64(len(encoded)) > uint64(limits.MaxEncodedBytes) {
			return capacityExceeded("stored bytes", uint64(len(encoded)), uint64(limits.MaxEncodedBytes))
		}
		e.encoded = encoded
		length = uint32(len(e.encoded)) - start
	}
	if uint64(len(e.units)) > uint64(limits.MaxTextUnits) {
		return capacityExceeded("stored units", uint64(len(e.units)), uint64(limits.MaxTextUnits))
	}
	e.kinds = append(e.kinds, kind)
	e.numbers = append(e.numbers, number)
	e.textStart = append(e.textStart, start)
	e.textLength = append(e.textLength, length)
	return nil
}

func isForeignNaN(value any) bool {
	number, isNumber := value.(float64)
	return isNumber && math.IsNaN(number) && math.Float64bits(number) != math.Float64bits(codec.JavaScriptNaN())
}

func holdsForeignNaN(value any, depth int) bool {
	if depth > codec.MaxDocumentEncodingDepth {
		return false
	}
	switch typed := value.(type) {
	case []any:
		for _, element := range typed {
			if holdsForeignNaN(element, depth+1) {
				return true
			}
		}
	case *codec.Document:
		for _, element := range codec.HeldEntries(typed) {
			if holdsForeignNaN(element, depth+1) {
				return true
			}
		}
	default:
		return isForeignNaN(value)
	}
	return false
}

func withJavaScriptNaN(value any, depth int) any {
	if depth > codec.MaxDocumentEncodingDepth {
		return value
	}
	switch typed := value.(type) {
	case []any:
		copied := make([]any, len(typed))
		for at, element := range typed {
			copied[at] = withJavaScriptNaN(element, depth+1)
		}
		return copied
	case *codec.Document:
		copied := codec.NewDocumentOfLength(typed.Len())
		for key, element := range codec.HeldEntries(typed) {
			codec.PutHeld(copied, key, withJavaScriptNaN(element, depth+1))
		}
		return copied
	}
	if isForeignNaN(value) {
		return codec.JavaScriptNaN()
	}
	return value
}

func buildStoredEntry(path string, value any, found bool, limits Limits) (storedEntry, error) {
	entry := storedEntry{shape: storedAbsent}
	if !found {
		return entry, nil
	}
	list, isList := value.([]any)
	if !isList {
		entry.shape = storedScalar
		return entry, entry.appendElement(path, value, -1, limits)
	}
	entry.shape = storedArray
	if uint64(len(list)) > uint64(limits.MaxEntries) {
		return entry, capacityExceeded("stored values", uint64(len(list)), uint64(limits.MaxEntries))
	}
	for index, element := range list {
		if err := entry.appendElement(path, element, index, limits); err != nil {
			return entry, err
		}
	}
	return entry, nil
}
