package codec

import (
	"math"
	"slices"
	"strings"

	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

const maxArrayIndex = 4294967294

func arrayIndexOf(key string) (uint64, bool) {
	if key == "" || len(key) > 10 || (len(key) > 1 && key[0] == '0') {
		return 0, false
	}
	var index uint64
	for position := 0; position < len(key); position++ {
		digit := key[position]
		if digit < '0' || digit > '9' {
			return 0, false
		}
		index = index*10 + uint64(digit-'0')
	}
	return index, index <= maxArrayIndex
}

func compareObjectKeys(left, right string) int {
	leftIndex, leftIsIndex := arrayIndexOf(left)
	rightIndex, rightIsIndex := arrayIndexOf(right)
	switch {
	case leftIsIndex && rightIsIndex:
		if leftIndex < rightIndex {
			return -1
		}
		if leftIndex > rightIndex {
			return 1
		}
		return 0
	case leftIsIndex:
		return -1
	case rightIsIndex:
		return 1
	}
	return strings.Compare(left, right)
}

func ObjectKeyOrder(record map[string]any) []string {
	keys := make([]string, 0, len(record))
	for key := range record {
		keys = append(keys, key)
	}
	SortObjectKeys(keys)
	return keys
}

func SortObjectKeys(keys []string) {
	slices.SortFunc(keys, compareObjectKeys)
}

func IsNegativeZero(value float64) bool {
	return value == 0 && math.Signbit(value)
}

func HoldsNegativeZero(value any, depth int) bool {
	switch typed := value.(type) {
	case float64:
		return IsNegativeZero(typed)
	case float32:
		return typed == 0 && math.Signbit(float64(typed))
	case []float64:
		if depth > MaxDocumentEncodingDepth {
			return false
		}
		return slices.ContainsFunc(typed, IsNegativeZero)
	case []any:
		if depth > MaxDocumentEncodingDepth {
			return false
		}
		for _, element := range typed {
			if HoldsNegativeZero(element, depth+1) {
				return true
			}
		}
	case map[string]any:
		if depth > MaxDocumentEncodingDepth {
			return false
		}
		for _, element := range typed {
			if HoldsNegativeZero(element, depth+1) {
				return true
			}
		}
	case OrderedMap:
		if depth > MaxDocumentEncodingDepth {
			return false
		}
		for _, entry := range typed {
			if HoldsNegativeZero(entry.Value, depth+1) {
				return true
			}
		}
	case *Document:
		return depth <= MaxDocumentEncodingDepth && documentHoldsNegativeZero(typed, depth)
	}
	return false
}

func documentEncodeOptions(value any, startDepth int) EncodeOptions {
	return EncodeOptions{
		ForceIntegerToFloat: HoldsNegativeZero(value, startDepth),
		MaxDepth:            MaxDocumentEncodingDepth,
		ErrorCode:           narsilerr.CodeDocValidationFailed,
	}
}

type DocumentEntries interface {
	map[string]any | OrderedMap | *Document
}

func AppendDocument[D DocumentEntries](destination []byte, document D) ([]byte, error) {
	start := len(destination)
	encoded, err := AppendValue(destination, any(document), documentEncodeOptions(any(document), 1))
	if err != nil {
		return destination[:start], narsilerr.New(
			narsilerr.CodeDocValidationFailed,
			"The document cannot be encoded as MessagePack: "+messageOf(err),
			nil,
		)
	}
	return encoded, nil
}

func EncodeDocument[D DocumentEntries](document D) ([]byte, error) {
	return AppendDocument(nil, document)
}

func messageOf(err error) string {
	if failure, ok := narsilerr.As(err); ok {
		return failure.Message
	}
	return err.Error()
}
