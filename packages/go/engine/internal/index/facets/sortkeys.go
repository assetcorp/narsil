package facets

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

func SortValues(source DocumentSource, id string, fields []string, modes []text.SortMode) []text.SortValue {
	key := make([]text.SortValue, len(fields))
	ordinal, found := source.OrdinalOf(id)
	if !found {
		return key
	}
	for index, fieldPath := range fields {
		mode := text.SortModeMin
		if index < len(modes) && modes[index] != "" {
			mode = modes[index]
		}
		value, present := storedFieldValue(source, ordinal, fieldPath)
		if !present {
			continue
		}
		key[index] = text.ToReducedSortValue(value, mode)
	}
	return key
}
