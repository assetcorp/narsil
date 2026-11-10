package filters

import (
	"math"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/geo"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

type operandKind string

const (
	kindNone     operandKind = ""
	kindNumber   operandKind = "number"
	kindBoolean  operandKind = "boolean"
	kindText     operandKind = "text"
	kindGeopoint operandKind = "geopoint"
	kindVector   operandKind = "vector"
)

func isFinite(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}

func operandKindOf(field schema.ParsedFieldType) operandKind {
	switch field.Base {
	case schema.BaseNumber, schema.BaseNumberList:
		return kindNumber
	case schema.BaseBoolean, schema.BaseBooleanList:
		return kindBoolean
	case schema.BaseGeopoint:
		return kindGeopoint
	case schema.BaseVector:
		return kindVector
	}
	return kindText
}

func kindOfValue(value model.FilterValue) operandKind {
	switch value.Kind() {
	case model.FilterValueNumber:
		if number, _ := value.Number(); isFinite(number) {
			return kindNumber
		}
	case model.FilterValueBoolean:
		return kindBoolean
	case model.FilterValueText:
		return kindText
	}
	return kindNone
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
	return isNumber && isFinite(number)
}

func requireRangeOperands(fieldPath string, filter *model.FieldFilter, field schema.ParsedFieldType) error {
	for _, named := range rangeBoundsOf(filter) {
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
		if err := requireFieldKind(fieldPath, named.operator, field, kindNumber); err != nil {
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
	return requireFieldKind(fieldPath, "between", field, kindNumber)
}

func requireValueOperands(fieldPath string, filter *model.FieldFilter, field schema.ParsedFieldType) error {
	for _, named := range affixesOf(filter) {
		if !named.text.IsSet() {
			continue
		}
		if err := requireFieldKind(fieldPath, named.operator, field, kindText); err != nil {
			return err
		}
	}
	for _, named := range equalitiesOf(filter) {
		if !named.value.IsSet() {
			continue
		}
		kind := kindOfValue(named.value)
		if kind == kindNone {
			return invalidOperand(onField(named.operator, fieldPath)+" must be a string, a finite number, or a boolean", fieldPath, named.operator)
		}
		if err := requireFieldKind(fieldPath, named.operator, field, kind); err != nil {
			return err
		}
	}
	for _, named := range membershipsOf(filter) {
		if named.values == nil {
			continue
		}
		if err := requireFieldKind(fieldPath, named.operator, field, kindText); err != nil {
			return err
		}
	}
	if filter.Radius != nil {
		if err := requireFieldKind(fieldPath, "radius", field, kindGeopoint); err != nil {
			return err
		}
	}
	if filter.Polygon != nil {
		return requireFieldKind(fieldPath, "polygon", field, kindGeopoint)
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
		return kindNumber, nil
	case schema.BaseBooleanList:
		return kindBoolean, nil
	case schema.BaseEnumList, schema.BaseStringList, schema.BaseVerbatimList:
		return kindText, nil
	}
	return kindNone, invalidOperand(`"`+operator+`" tests the elements of a list field, while the schema declares field "`+
		fieldPath+`" as "`+string(field.Type)+`"`, fieldPath, operator)
}

func elementKindWord(kind operandKind) string {
	switch kind {
	case kindText:
		return "string"
	case kindNumber:
		return "finite number"
	}
	return "boolean"
}

func requireElementOperands(fieldPath string, filter *model.FieldFilter, field schema.ParsedFieldType) error {
	for _, named := range elementListsOf(filter) {
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
	for _, named := range sizeBoundsOf(size) {
		if bound, set := named.bound.Get(); set && !isFinite(bound) {
			return invalidOperand(`"size.`+named.operator+`" on field "`+fieldPath+`" must be a finite number`, fieldPath, "size")
		}
	}
	if interval, set := size.Between.Get(); set && (!isFinite(interval.Low) || !isFinite(interval.High)) {
		return invalidOperand(`"size.between" on field "`+fieldPath+`" must be two finite numbers, the lower bound first`, fieldPath, "size")
	}
	return nil
}

func requireGeoOperands(fieldPath string, filter *model.FieldFilter, _ schema.ParsedFieldType) error {
	if err := geo.ValidateRadius(fieldPath, filter.Radius); err != nil {
		return err
	}
	return geo.ValidatePolygon(fieldPath, filter.Polygon)
}
