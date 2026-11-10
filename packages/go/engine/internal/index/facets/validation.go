package facets

import (
	"strconv"
	"strings"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

func quoted(value string) string {
	return `"` + value + `"`
}

func undeclaredFieldOnStrictIndex(field, option string) *narsilerr.Error {
	return narsilerr.New(
		narsilerr.CodeSearchInvalidField,
		"The index is strict and its schema declares no field "+quoted(field)+", so no stored document has a value in that field for this "+option,
		map[string]any{"field": field, "option": option},
	)
}

func isGeopointOrVector(field schema.Field) bool {
	return field.Base == schema.BaseGeopoint || field.Base == schema.BaseVector
}

func facetFieldOrder(config model.FacetConfig) []string {
	keys := make(map[string]any, len(config))
	for fieldPath := range config {
		keys[fieldPath] = nil
	}
	return codec.ObjectKeyOrder(keys)
}

func RequireFacetableFields(config model.FacetConfig, parsed *schema.Parsed, strict bool) error {
	for _, fieldPath := range facetFieldOrder(config) {
		field, declared := parsed.Field(fieldPath)
		if strict && !declared {
			return undeclaredFieldOnStrictIndex(fieldPath, "facet")
		}
		if declared && isGeopointOrVector(field) {
			return narsilerr.New(
				narsilerr.CodeSearchInvalidField,
				"The engine counts the values of a text, number, boolean, or enum field, and the schema declares field "+quoted(fieldPath)+" as "+quoted(string(field.Type)),
				map[string]any{"field": fieldPath, "fieldType": string(field.Type)},
			)
		}
	}
	return nil
}

func quotedSortModes() string {
	modes := text.SortModes()
	written := make([]string, len(modes))
	for index, mode := range modes {
		written[index] = quoted(string(mode))
	}
	return strings.Join(written, ", ")
}

func requireSortMode(entry model.SortField, field schema.Field, declared bool) error {
	if entry.Mode == "" {
		return nil
	}
	if !text.IsSortMode(string(entry.Mode)) {
		return narsilerr.New(
			narsilerr.CodeSearchInvalidMode,
			"A sort mode is one of "+quotedSortModes()+", and the mode on "+quoted(entry.Field)+" is "+quoted(string(entry.Mode)),
			map[string]any{"field": entry.Field, "mode": string(entry.Mode)},
		)
	}
	averages := entry.Mode == model.SortByMean || entry.Mode == model.SortByMedian
	if averages && declared && field.Base != schema.BaseNumber && field.Base != schema.BaseNumberList {
		fieldType := string(field.Type)
		return narsilerr.New(
			narsilerr.CodeSearchInvalidField,
			"The engine applies the "+quoted(string(entry.Mode))+" mode to a number field alone, and "+quoted(entry.Field)+" is a "+fieldType+" field",
			map[string]any{"field": entry.Field, "fieldType": fieldType, "mode": string(entry.Mode)},
		)
	}
	return nil
}

func withSortableOption(field schema.ParsedFieldType) string {
	written := string(field.Type)
	if field.Sortable {
		return written
	}
	baseName, _, _ := strings.Cut(written, ":")
	widened, err := schema.ParseFieldType(baseName+":sortable"+written[len(baseName):], "")
	if err != nil {
		return written
	}
	return string(widened.Type)
}

func requireSortableType(entry model.SortField, field schema.Field) error {
	fieldType := string(field.Type)
	if field.IsStringValued() && !field.Sortable {
		return narsilerr.New(
			narsilerr.CodeSearchInvalidField,
			"The engine sorts by text field "+quoted(entry.Field)+" only where its type includes \"sortable\", as in "+quoted(withSortableOption(field.ParsedFieldType))+", because it keeps up to the first "+strconv.Itoa(text.SortValueMaxCodePoints)+" code points of every document's value in memory to sort by a text field",
			map[string]any{"field": entry.Field, "fieldType": fieldType},
		)
	}
	if isGeopointOrVector(field) {
		return narsilerr.New(
			narsilerr.CodeSearchInvalidField,
			"The engine sorts by a number, boolean, enum, or sortable text field, and "+quoted(entry.Field)+" is a "+fieldType+" field",
			map[string]any{"field": entry.Field, "fieldType": fieldType},
		)
	}
	return nil
}

func RequireSortableFields(sort []model.SortField, parsed *schema.Parsed, strict bool) error {
	for _, entry := range sort {
		field, declared := parsed.Field(entry.Field)
		if strict && !declared {
			return undeclaredFieldOnStrictIndex(entry.Field, "sort")
		}
		if entry.Direction != model.SortAscending && entry.Direction != model.SortDescending {
			return narsilerr.New(
				narsilerr.CodeSearchInvalidMode,
				"A sort direction is \"asc\" or \"desc\", and the direction on "+quoted(entry.Field)+" is "+quoted(string(entry.Direction)),
				map[string]any{"field": entry.Field, "direction": string(entry.Direction)},
			)
		}
		if err := requireSortMode(entry, field, declared); err != nil {
			return err
		}
		if !declared {
			continue
		}
		if err := requireSortableType(entry, field); err != nil {
			return err
		}
	}
	return nil
}
