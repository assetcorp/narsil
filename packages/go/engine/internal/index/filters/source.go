package filters

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/bitset"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/fieldindex"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/geo"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

type Source interface {
	Capacity() int
	Live() bitset.Bits
	Numeric(fieldPath string) *fieldindex.Numeric
	Boolean(fieldPath string) *fieldindex.Boolean
	Enum(fieldPath string) *fieldindex.Enum
	Geo(fieldPath string) *geo.Index
	Sizes(fieldPath string) *fieldindex.Numeric
	Document(ordinal uint32) (map[string]any, bool)
	ExternalID(ordinal uint32) (string, bool)
	Ordinal(id string) (uint32, bool)
}

type PatternScope interface {
	Source() Source
	Capacity() int
	Universe() bitset.Bits
	Present(fieldPath string) bitset.Bits
}

type PatternSearch interface {
	CheckOperands(fieldPath string, filter *model.FieldFilter) error
	EvaluateTests(scope PatternScope, fieldPath string, filter *model.FieldFilter, narrow func(matched bitset.Bits)) error
	MatchEqualInto(scope PatternScope, fieldPath string, value string, into bitset.Bits) error
}
