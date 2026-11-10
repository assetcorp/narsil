package filters

import (
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

func invalidOperand(message, fieldPath, operator string) error {
	return narsilerr.New(narsilerr.CodeSearchInvalidFilter, message, map[string]any{"fieldPath": fieldPath, "operator": operator})
}

func invalidShape(message string) error {
	return narsilerr.New(narsilerr.CodeSearchInvalidFilter, message, nil)
}

func undeclaredFilterField(field string) error {
	return narsilerr.New(narsilerr.CodeSearchInvalidField,
		`The schema declares no field "`+field+`", while the engine answers a filter only from the indexes that it keeps for declared fields. Declare the field in the schema of a new index to filter by it`,
		map[string]any{"field": field, "option": "filter"})
}

func missingPatternSearch(fieldPath string) error {
	return narsilerr.New(narsilerr.CodeConfigInvalid,
		`Field "`+fieldPath+`" is a pattern field, but this engine holds no pattern search code, so it cannot answer a filter on that field`,
		map[string]any{"field": fieldPath})
}

func overlongList(fieldPath, operator string, length int) error {
	return invalidOperand(`"`+operator+`" on field "`+fieldPath+`" holds `+strconv.Itoa(length)+
		" values, while a filter list holds at most "+strconv.Itoa(maxFilterListLength), fieldPath, operator)
}

func unpairedSurrogate(fieldPath, operator string) error {
	return invalidOperand(`The text of "`+operator+`" on field "`+fieldPath+
		`" holds an unpaired surrogate, the half of a character such as an emoji whose other half is missing, so no stored value can hold it`,
		fieldPath, operator)
}
