package schema

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type BaseFieldType string

const (
	BaseString       BaseFieldType = "string"
	BaseStringList   BaseFieldType = "string[]"
	BaseVerbatim     BaseFieldType = "verbatim"
	BaseVerbatimList BaseFieldType = "verbatim[]"
	BaseNumber       BaseFieldType = "number"
	BaseNumberList   BaseFieldType = "number[]"
	BaseBoolean      BaseFieldType = "boolean"
	BaseBooleanList  BaseFieldType = "boolean[]"
	BaseEnum         BaseFieldType = "enum"
	BaseEnumList     BaseFieldType = "enum[]"
	BaseGeopoint     BaseFieldType = "geopoint"
	BaseVector       BaseFieldType = "vector"
)

type ParsedFieldType struct {
	Type      model.FieldType
	Base      BaseFieldType
	Sortable  bool
	Pattern   bool
	Partial   bool
	Dimension int
}

func (p ParsedFieldType) IsList() bool {
	return strings.HasSuffix(string(p.Base), "[]")
}

func (p ParsedFieldType) IsWordIndexed() bool {
	return p.Base == BaseString || p.Base == BaseStringList
}

func (p ParsedFieldType) IsStringValued() bool {
	return p.IsWordIndexed() || p.Base == BaseVerbatim || p.Base == BaseVerbatimList
}

const typeOptionSeparator = ":"

var fieldOptionOrder = []model.TextFieldOption{model.TextFieldSortable, model.TextFieldPattern, model.TextFieldPartial}

var optionsByBase = map[BaseFieldType][]model.TextFieldOption{
	BaseString:       fieldOptionOrder,
	BaseStringList:   fieldOptionOrder,
	BaseVerbatim:     {model.TextFieldSortable},
	BaseVerbatimList: {model.TextFieldSortable},
	BaseNumber:       nil,
	BaseNumberList:   nil,
	BaseBoolean:      nil,
	BaseBooleanList:  nil,
	BaseEnum:         nil,
	BaseEnumList:     nil,
	BaseGeopoint:     nil,
}

var (
	vectorTypePattern  = regexp.MustCompile(`^vector\[([0-9]+)]$`)
	wholeNumberPattern = regexp.MustCompile(`^[0-9]+$`)
)

func invalidFieldType(path, fieldType, message string) *narsilerr.Error {
	return narsilerr.New(narsilerr.CodeSchemaInvalidType, message, map[string]any{"field": path, "type": fieldType})
}

func describeAllowedOptions(baseName string, allowed []model.TextFieldOption) string {
	if len(allowed) == 0 {
		return fmt.Sprintf("the %q type has no options", baseName)
	}
	quoted := make([]string, len(allowed))
	for i, option := range allowed {
		quoted[i] = strconv.Quote(string(option))
	}
	if len(quoted) == 1 {
		return fmt.Sprintf("the only option of the %q type is %s", baseName, quoted[0])
	}
	return fmt.Sprintf("the options of the %q type are %s, and %s", baseName, strings.Join(quoted[:len(quoted)-1], ", "), quoted[len(quoted)-1])
}

func vectorDimensionError(path string, written string) *narsilerr.Error {
	dimension := math.NaN()
	if wholeNumberPattern.MatchString(written) {
		dimension, _ = strconv.ParseFloat(written, 64)
	}
	return narsilerr.New(
		narsilerr.CodeSchemaInvalidVectorDimension,
		fmt.Sprintf("Vector field %q has %s dimensions, but a vector field holds from 1 to %d", path, written, MaxStoredVectorDimension),
		map[string]any{"field": path, "dimension": dimension, "maximum": MaxStoredVectorDimension},
	)
}

func parseVectorBase(baseName, path, fieldType string) (int, error) {
	written, isVectorType := strings.CutPrefix(baseName, "vector[")
	written, closed := strings.CutSuffix(written, "]")
	if !isVectorType || !closed {
		return 0, invalidFieldType(path, fieldType, fmt.Sprintf("Field %q has an unsupported type: %q", path, fieldType))
	}
	match := vectorTypePattern.FindStringSubmatch(baseName)
	if match == nil {
		return 0, vectorDimensionError(path, written)
	}
	digits := strings.TrimLeft(match[1], "0")
	if len(digits) > len(strconv.Itoa(MaxStoredVectorDimension)) {
		return 0, vectorDimensionError(path, written)
	}
	dimension := 0
	if digits != "" {
		parsed, err := strconv.Atoi(digits)
		if err != nil {
			return 0, vectorDimensionError(path, written)
		}
		dimension = parsed
	}
	if dimension <= 0 || dimension > MaxStoredVectorDimension {
		return 0, vectorDimensionError(path, written)
	}
	return dimension, nil
}

func parseBase(baseName, path, fieldType string) (BaseFieldType, int, error) {
	base := BaseFieldType(baseName)
	if _, named := optionsByBase[base]; named {
		return base, 0, nil
	}
	dimension, err := parseVectorBase(baseName, path, fieldType)
	if err != nil {
		return "", 0, err
	}
	return BaseVector, dimension, nil
}

func ParseFieldType(fieldType string, path string) (ParsedFieldType, error) {
	baseName, optionText, hasOptions := strings.Cut(fieldType, typeOptionSeparator)
	base, dimension, err := parseBase(baseName, path, fieldType)
	if err != nil {
		return ParsedFieldType{}, err
	}
	allowed := optionsByBase[base]
	chosen := map[model.TextFieldOption]bool{}
	if hasOptions {
		for _, written := range strings.Split(optionText, typeOptionSeparator) {
			option := model.TextFieldOption(written)
			if !containsOption(allowed, option) {
				return ParsedFieldType{}, invalidFieldType(path, fieldType, fmt.Sprintf("Field %q has type %q with the option %q, but %s", path, fieldType, written, describeAllowedOptions(baseName, allowed)))
			}
			if chosen[option] {
				return ParsedFieldType{}, invalidFieldType(path, fieldType, fmt.Sprintf("Field %q has the %q option twice in type %q", path, written, fieldType))
			}
			chosen[option] = true
		}
	}
	canonical := baseName
	for _, option := range fieldOptionOrder {
		if chosen[option] {
			canonical += typeOptionSeparator + string(option)
		}
	}
	verbatim := base == BaseVerbatim || base == BaseVerbatimList
	return ParsedFieldType{
		Type:      model.FieldType(canonical),
		Base:      base,
		Sortable:  chosen[model.TextFieldSortable],
		Pattern:   verbatim || chosen[model.TextFieldPattern],
		Partial:   chosen[model.TextFieldPartial],
		Dimension: dimension,
	}, nil
}

func containsOption(allowed []model.TextFieldOption, option model.TextFieldOption) bool {
	for _, candidate := range allowed {
		if candidate == option {
			return true
		}
	}
	return false
}
