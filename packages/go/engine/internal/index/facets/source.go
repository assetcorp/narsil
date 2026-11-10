package facets

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/bitset"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/fieldindex"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type DocumentSource interface {
	StoredDocument(ordinal uint32) (map[string]any, bool)
	OrdinalOf(id string) (uint32, bool)
}

type NumericIndexes interface {
	NumericIndex(fieldPath string) *fieldindex.Numeric
}

type Source interface {
	DocumentSource
	NumericIndexes
	BooleanIndex(fieldPath string) *fieldindex.Boolean
	EnumIndex(fieldPath string) *fieldindex.Enum
	OrdinalCapacity() int
}

func MatchedOrdinalsOf(source Source, ids []string) bitset.Bits {
	matched := bitset.New(source.OrdinalCapacity())
	for _, id := range ids {
		if ordinal, found := source.OrdinalOf(id); found {
			matched.Set(ordinal)
		}
	}
	return matched
}

func storedFieldValue(source DocumentSource, ordinal uint32, fieldPath string) (any, bool) {
	document, live := source.StoredDocument(ordinal)
	if !live {
		return nil, false
	}
	return text.ReadSortField(document, fieldPath)
}

func forEachMatchedValue(source DocumentSource, fieldPath string, matched bitset.Bits, visit func(value any)) {
	matched.ForEach(func(ordinal uint32) bool {
		if value, found := storedFieldValue(source, ordinal, fieldPath); found {
			visit(value)
		}
		return true
	})
}
