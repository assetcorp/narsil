package query

import (
	"math"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

type operandKind string

const (
	operandNone     operandKind = ""
	operandNumber   operandKind = "number"
	operandBoolean  operandKind = "boolean"
	operandText     operandKind = "text"
	operandGeopoint operandKind = "geopoint"
	operandVector   operandKind = "vector"
)

func invalidOperand(message, fieldPath, operator string) error {
	return narsilerr.New(narsilerr.CodeSearchInvalidFilter, message, map[string]any{"fieldPath": fieldPath, "operator": operator})
}

func finite(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}

func operandKindOf(field schema.ParsedFieldType) operandKind {
	switch field.Base {
	case schema.BaseNumber, schema.BaseNumberList:
		return operandNumber
	case schema.BaseBoolean, schema.BaseBooleanList:
		return operandBoolean
	case schema.BaseGeopoint:
		return operandGeopoint
	case schema.BaseVector:
		return operandVector
	}
	return operandText
}

func kindOfValue(value model.FilterValue) operandKind {
	switch value.Kind() {
	case model.FilterValueNumber:
		if number, _ := value.Number(); finite(number) {
			return operandNumber
		}
	case model.FilterValueBoolean:
		return operandBoolean
	case model.FilterValueText:
		return operandText
	}
	return operandNone
}

func onField(operator, fieldPath string) string {
	return `"` + operator + `" on field "` + fieldPath + `"`
}

func requireFieldKind(fieldPath, operator string, field schema.ParsedFieldType, accepted operandKind) error {
	if operandKindOf(field) == accepted {
		return nil
	}
	return invalidOperand(`The engine applies "`+operator+`" to `+string(accepted)+` fields alone, and the schema declares field "`+
		fieldPath+`" as "`+string(field.Type)+`"`, fieldPath, operator)
}

func requireTextRangeField(fieldPath, operator string, field schema.ParsedFieldType) error {
	if field.Sortable && (field.Base == schema.BaseString || field.Base == schema.BaseVerbatim) {
		return nil
	}
	return invalidOperand(`The engine applies "`+operator+`" with a text bound to a "string" or "verbatim" field whose type includes "sortable", but field "`+
		fieldPath+`" has type "`+string(field.Type)+`"`, fieldPath, operator)
}

func finiteBound(bound model.RangeBound) bool {
	number, isNumber := bound.Number()
	return isNumber && finite(number)
}

func requireRangeOperands(fieldPath string, filter *model.FieldFilter, field schema.ParsedFieldType) error {
	bounds := []struct {
		operator string
		bound    model.RangeBound
	}{{"gt", filter.Gt}, {"lt", filter.Lt}, {"gte", filter.Gte}, {"lte", filter.Lte}}
	for _, named := range bounds {
		switch named.bound.Kind() {
		case model.RangeBoundAbsent:
			continue
		case model.RangeBoundText:
			if err := requireTextRangeField(fieldPath, named.operator, field); err != nil {
				return err
			}
			continue
		}
		if !finiteBound(named.bound) {
			return invalidOperand(onField(named.operator, fieldPath)+" must be a finite number or a string", fieldPath, named.operator)
		}
		if err := requireFieldKind(fieldPath, named.operator, field, operandNumber); err != nil {
			return err
		}
	}
	between := filter.Between
	if !between.IsSet() {
		return nil
	}
	if between.Low.Kind() == model.RangeBoundText && between.High.Kind() == model.RangeBoundText {
		return requireTextRangeField(fieldPath, "between", field)
	}
	if !finiteBound(between.Low) || !finiteBound(between.High) {
		return invalidOperand(onField("between", fieldPath)+" must be two finite numbers or two strings, the lower bound first", fieldPath, "between")
	}
	return requireFieldKind(fieldPath, "between", field, operandNumber)
}

func requireValueOperands(fieldPath string, filter *model.FieldFilter, field schema.ParsedFieldType) error {
	affixes := []struct {
		operator string
		text     model.Optional[string]
	}{{"startsWith", filter.StartsWith}, {"endsWith", filter.EndsWith}}
	for _, named := range affixes {
		if !named.text.IsSet() {
			continue
		}
		if err := requireFieldKind(fieldPath, named.operator, field, operandText); err != nil {
			return err
		}
	}
	equalities := []struct {
		operator string
		value    model.FilterValue
	}{{"eq", filter.Eq}, {"ne", filter.Ne}}
	for _, named := range equalities {
		if !named.value.IsSet() {
			continue
		}
		kind := kindOfValue(named.value)
		if kind == operandNone {
			return invalidOperand(onField(named.operator, fieldPath)+" must be a string, a finite number, or a boolean", fieldPath, named.operator)
		}
		if err := requireFieldKind(fieldPath, named.operator, field, kind); err != nil {
			return err
		}
	}
	memberships := []struct {
		operator string
		values   []string
	}{{"in", filter.In}, {"nin", filter.Nin}}
	for _, named := range memberships {
		if named.values == nil {
			continue
		}
		if err := requireFieldKind(fieldPath, named.operator, field, operandText); err != nil {
			return err
		}
	}
	if filter.Radius != nil {
		if err := requireFieldKind(fieldPath, "radius", field, operandGeopoint); err != nil {
			return err
		}
	}
	if filter.Polygon != nil {
		return requireFieldKind(fieldPath, "polygon", field, operandGeopoint)
	}
	return nil
}

func wholeValueOperators(filter *model.FieldFilter) []string {
	held := []struct {
		operator string
		present  bool
	}{
		{"eq", filter.Eq.IsSet()}, {"ne", filter.Ne.IsSet()}, {"in", filter.In != nil}, {"nin", filter.Nin != nil},
		{"startsWith", filter.StartsWith.IsSet()}, {"endsWith", filter.EndsWith.IsSet()},
		{"matchesAny", filter.MatchesAny != nil}, {"containsAll", filter.ContainsAll != nil},
	}
	var operators []string
	for _, entry := range held {
		if entry.present {
			operators = append(operators, entry.operator)
		}
	}
	return operators
}

func requireWholeValueIndex(fieldPath string, filter *model.FieldFilter, field schema.ParsedFieldType) error {
	if field.Pattern || (field.Base != schema.BaseString && field.Base != schema.BaseStringList) {
		return nil
	}
	operators := wholeValueOperators(filter)
	if len(operators) == 0 {
		return nil
	}
	base := string(field.Base)
	return invalidOperand(`"`+operators[0]+`" compares whole values of field "`+fieldPath+
		`", which the engine finds only through a pattern index. A "`+base+`" field keeps a pattern index where its type includes "pattern", so declare the field as "`+
		base+`:pattern" in a new index to filter it this way`, fieldPath, operators[0])
}

func listElementKind(fieldPath, operator string, field schema.ParsedFieldType) (operandKind, error) {
	switch field.Base {
	case schema.BaseNumberList:
		return operandNumber, nil
	case schema.BaseBooleanList:
		return operandBoolean, nil
	case schema.BaseEnumList, schema.BaseStringList, schema.BaseVerbatimList:
		return operandText, nil
	}
	return operandNone, invalidOperand(`"`+operator+`" tests the elements of a list field, while the schema declares field "`+
		fieldPath+`" as "`+string(field.Type)+`"`, fieldPath, operator)
}

func elementKindWord(kind operandKind) string {
	switch kind {
	case operandText:
		return "string"
	case operandNumber:
		return "finite number"
	}
	return "boolean"
}

func requireElementOperands(fieldPath string, filter *model.FieldFilter, field schema.ParsedFieldType) error {
	lists := []struct {
		operator string
		values   []model.FilterValue
	}{{"matchesAny", filter.MatchesAny}, {"containsAll", filter.ContainsAll}}
	for _, named := range lists {
		if named.values == nil {
			continue
		}
		kind, err := listElementKind(fieldPath, named.operator, field)
		if err != nil {
			return err
		}
		for _, value := range named.values {
			if kindOfValue(value) != kind {
				return invalidOperand(`Every value of "`+named.operator+`" on field "`+fieldPath+`" must be a `+elementKindWord(kind)+
					", because the field holds a list of them", fieldPath, named.operator)
			}
		}
	}
	return nil
}

func requireSizeOperands(fieldPath string, filter *model.FieldFilter, field schema.ParsedFieldType) error {
	size := filter.Size
	if size == nil {
		return nil
	}
	if _, err := listElementKind(fieldPath, "size", field); err != nil {
		return err
	}
	bounds := []struct {
		operator string
		bound    model.Optional[float64]
	}{{"eq", size.Eq}, {"ne", size.Ne}, {"gt", size.Gt}, {"gte", size.Gte}, {"lt", size.Lt}, {"lte", size.Lte}}
	for _, named := range bounds {
		if bound, set := named.bound.Get(); set && !finite(bound) {
			return invalidOperand(`"size.`+named.operator+`" on field "`+fieldPath+`" must be a finite number`, fieldPath, "size")
		}
	}
	if interval, set := size.Between.Get(); set && (!finite(interval.Low) || !finite(interval.High)) {
		return invalidOperand(`"size.between" on field "`+fieldPath+`" must be two finite numbers, the lower bound first`, fieldPath, "size")
	}
	return nil
}

func requireListLengths(fieldPath string, filter *model.FieldFilter) error {
	polygonPoints := 0
	if filter.Polygon != nil {
		polygonPoints = len(filter.Polygon.Points)
	}
	lengths := []struct {
		operator string
		held     bool
		length   int
	}{
		{"in", filter.In != nil, len(filter.In)},
		{"nin", filter.Nin != nil, len(filter.Nin)},
		{"containsAll", filter.ContainsAll != nil, len(filter.ContainsAll)},
		{"matchesAny", filter.MatchesAny != nil, len(filter.MatchesAny)},
		{"polygon", filter.Polygon != nil && filter.Polygon.Points != nil, polygonPoints},
	}
	for _, list := range lengths {
		if list.held && list.length > MaxFilterListItems {
			return invalidOperand(`"`+list.operator+`" on field "`+fieldPath+`" holds `+strconv.Itoa(list.length)+
				" values, while a filter list holds at most "+strconv.Itoa(MaxFilterListItems), fieldPath, list.operator)
		}
	}
	return nil
}
