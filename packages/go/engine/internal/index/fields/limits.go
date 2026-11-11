package fields

import (
	"errors"
	"fmt"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type Limits struct {
	MaxOrdinals       uint32
	MaxEntries        uint32
	MaxTextUnits      uint32
	MaxEncodedBytes   uint32
	PatternValueLimit uint32
}

func DefaultLimits() Limits {
	return Limits{
		MaxOrdinals:       DefaultMaxOrdinals,
		MaxEntries:        DefaultMaxEntries,
		MaxTextUnits:      DefaultMaxTextUnits,
		MaxEncodedBytes:   DefaultMaxEncodedBytes,
		PatternValueLimit: DefaultPatternValueLimit,
	}
}

func (l Limits) validate() error {
	if l.MaxOrdinals == 0 || l.MaxEntries == 0 || l.MaxTextUnits == 0 || l.MaxEncodedBytes == 0 ||
		l.PatternValueLimit == 0 || l.PatternValueLimit > MaxPatternValueLimit || l.MaxOrdinals == layoutCountLimit {
		return narsilerr.New(narsilerr.CodeConfigInvalid,
			"every field index limit must be above 0, the ordinal limit must stay below 4,294,967,295, and the pattern value limit must be at most 65,536",
			map[string]any{
				"maxOrdinals": float64(l.MaxOrdinals), "maxEntries": float64(l.MaxEntries),
				"maxTextUnits": float64(l.MaxTextUnits), "maxEncodedBytes": float64(l.MaxEncodedBytes),
				"patternValueLimit": float64(l.PatternValueLimit),
			})
	}
	return nil
}

func (l Limits) checkOrdinal(ordinal uint32) error {
	if ordinal >= l.MaxOrdinals {
		return narsilerr.New(narsilerr.CodePartitionCapacityExceeded,
			fmt.Sprintf("ordinal %d is outside the %d ordinals that this field index holds", ordinal, l.MaxOrdinals),
			map[string]any{"ordinal": float64(ordinal), "maxOrdinals": float64(l.MaxOrdinals)})
	}
	return nil
}

func capacityExceeded(what string, needed uint64, limit uint64) error {
	return narsilerr.New(narsilerr.CodePartitionCapacityExceeded,
		fmt.Sprintf("the %s of this field index would hold %d entries, above its limit of %d", what, needed, limit),
		map[string]any{"region": what, "needed": float64(needed), "limit": float64(limit)})
}

func regionFailure(what string, err error) error {
	if errors.Is(err, core.ErrRegionFull) {
		return narsilerr.Wrap(narsilerr.CodePartitionCapacityExceeded,
			"the "+what+" of this field index cannot grow past the memory that it reserved", err,
			map[string]any{"region": what})
	}
	return narsilerr.Wrap(narsilerr.CodePartitionCapacityExceeded,
		"the operating system refused the memory that the "+what+" of this field index asked for", err,
		map[string]any{"region": what})
}

func coreFailure(operation string, err error) error {
	return narsilerr.Wrap(narsilerr.CodePartitionCorrupted,
		"the native search core refused "+operation+" over a field index", err,
		map[string]any{"operation": operation})
}

func invalidValue(path, message string, details map[string]any) error {
	if details == nil {
		details = map[string]any{}
	}
	details["field"] = path
	return narsilerr.New(narsilerr.CodeDocValidationFailed, fmt.Sprintf("Field %q %s", path, message), details)
}

func invalidGeopoint(path, message string) error {
	return narsilerr.New(narsilerr.CodeSchemaInvalidGeopoint, fmt.Sprintf("Field %q %s", path, message),
		map[string]any{"field": path})
}

func grownCapacity(current, needed, minimum, maximum uint64) uint64 {
	return max(needed, min(maximum, current*2), minimum)
}
