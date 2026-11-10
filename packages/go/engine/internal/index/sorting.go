package index

import (
	"slices"
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

func sortModeOf(entry model.SortField) text.SortMode {
	return text.SortModeOf(text.SortDirection(entry.Direction), text.SortMode(entry.Mode))
}

func sortModesOf(fields []model.SortField) []text.SortMode {
	modes := make([]text.SortMode, len(fields))
	for index, entry := range fields {
		modes[index] = sortModeOf(entry)
	}
	return modes
}

func sortDirectionsOf(fields []model.SortField) []text.SortDirection {
	directions := make([]text.SortDirection, len(fields))
	for index, entry := range fields {
		directions[index] = text.SortDirection(entry.Direction)
	}
	return directions
}

func quotedSortModes() string {
	modes := text.SortModes()
	written := make([]string, len(modes))
	for index, mode := range modes {
		written[index] = quoted(string(mode))
	}
	return strings.Join(written, ", ")
}

func requireSortMode(entry model.SortField, fieldType string, declared bool) error {
	if entry.Mode == "" {
		return nil
	}
	if !text.IsSortMode(string(entry.Mode)) {
		return narsilerr.New(narsilerr.CodeSearchInvalidMode,
			"A sort mode is one of "+quotedSortModes()+", and the mode on "+quoted(entry.Field)+" is "+quoted(string(entry.Mode)),
			map[string]any{"field": entry.Field, "mode": string(entry.Mode)})
	}
	averages := entry.Mode == model.SortByMean || entry.Mode == model.SortByMedian
	if averages && declared && fieldType != string(model.FieldNumber) && fieldType != string(model.FieldNumberList) {
		return narsilerr.New(narsilerr.CodeSearchInvalidField,
			"The engine applies the "+quoted(string(entry.Mode))+" mode to a number field alone, and "+quoted(entry.Field)+" is a "+fieldType+" field",
			map[string]any{"field": entry.Field, "fieldType": fieldType, "mode": string(entry.Mode)})
	}
	return nil
}

func withSortableOption(parsed schema.ParsedFieldType) string {
	if parsed.Sortable {
		return string(parsed.Type)
	}
	written := string(parsed.Type)
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
		return narsilerr.New(narsilerr.CodeSearchInvalidField,
			"The engine sorts by text field "+quoted(entry.Field)+" only where its type includes \"sortable\", as in "+quoted(withSortableOption(field.ParsedFieldType))+
				", because it keeps up to the first "+strconv.Itoa(text.SortValueMaxCodePoints)+" code points of every document's value in memory to sort by a text field",
			map[string]any{"field": entry.Field, "fieldType": fieldType})
	}
	if field.Base == schema.BaseGeopoint || field.Base == schema.BaseVector {
		return narsilerr.New(narsilerr.CodeSearchInvalidField,
			"The engine sorts by a number, boolean, enum, or sortable text field, and "+quoted(entry.Field)+" is a "+fieldType+" field",
			map[string]any{"field": entry.Field, "fieldType": fieldType})
	}
	return nil
}

func requireSortableFields(sort []model.SortField, parsed *schema.Parsed, strict bool) error {
	for _, entry := range sort {
		field, declared := parsed.Field(entry.Field)
		if strict && !declared {
			return undeclaredFieldOnStrictIndex(entry.Field, "sort")
		}
		if entry.Direction != model.SortAscending && entry.Direction != model.SortDescending {
			return narsilerr.New(narsilerr.CodeSearchInvalidMode,
				"A sort direction is \"asc\" or \"desc\", and the direction on "+quoted(entry.Field)+" is "+quoted(string(entry.Direction)),
				map[string]any{"field": entry.Field, "direction": string(entry.Direction)})
		}
		if err := requireSortMode(entry, string(field.Type), declared); err != nil {
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

func documentProperty(container any, key string) (any, bool, bool) {
	document, isDocument := container.(*codec.Document)
	if !isDocument {
		return nil, false, false
	}
	value, found := codec.HeldValue(document, key)
	return value, found, true
}

func readSortValues(document *codec.Document, fields []string, modes []text.SortMode) []text.SortValue {
	values := make([]text.SortValue, len(fields))
	for index, field := range fields {
		if document == nil {
			values[index] = text.MissingSortValue()
			continue
		}
		mode := text.SortModeMin
		if index < len(modes) && modes[index] != "" {
			mode = modes[index]
		}
		raw, found := text.ReadSortField(document, field, documentProperty)
		if !found {
			raw = nil
		}
		values[index] = text.ToReducedSortValue(raw, mode)
	}
	return values
}

func applySorting(hits []resultHit, sort []model.SortField, sortKeyOf func(id string) []text.SortValue) []resultHit {
	if len(sort) == 0 {
		return hits
	}
	directions := sortDirectionsOf(sort)
	keys := make(map[string][]text.SortValue, len(hits))
	for _, hit := range hits {
		keys[hit.ID] = sortKeyOf(hit.ID)
	}
	sorted := append([]resultHit(nil), hits...)
	slices.SortStableFunc(sorted, func(left, right resultHit) int {
		if comparison := text.CompareComparableKeys(keys[left.ID], keys[right.ID], directions); comparison != 0 {
			return comparison
		}
		return text.CompareCodePoints(left.ID, right.ID)
	})
	return sorted
}
