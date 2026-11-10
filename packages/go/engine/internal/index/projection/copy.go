package projection

import (
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

func CopyDocument(document model.Document) model.Document {
	if document == nil {
		return model.Document{}
	}
	return copyRecord(document)
}

func CopyValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		if typed == nil {
			return typed
		}
		return copyRecord(typed)
	case []any:
		if typed == nil {
			return typed
		}
		copied := make([]any, len(typed))
		for position, element := range typed {
			copied[position] = CopyValue(element)
		}
		return copied
	case []byte:
		return slices.Clone(typed)
	case []float32:
		return slices.Clone(typed)
	}
	return value
}

func copyRecord(record map[string]any) map[string]any {
	copied := make(map[string]any, len(record))
	for key, element := range record {
		copied[key] = CopyValue(element)
	}
	return copied
}
