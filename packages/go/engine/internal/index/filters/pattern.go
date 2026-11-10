package filters

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

func requirePatternField(fieldPath, operator string, field schema.ParsedFieldType) error {
	if field.Pattern {
		return nil
	}
	return invalidOperand(`"`+operator+`" applies only to a pattern field, because only a pattern field has a pattern index. A pattern field is a "verbatim" field, or a text field whose type includes "pattern". Field "`+
		fieldPath+`" has type "`+string(field.Type)+`"`, fieldPath, operator)
}

func holdsPatternOperand(filter *model.FieldFilter) bool {
	return filter.Contains.IsSet() || filter.CaseFold || filter.Tolerance.Kind() != model.PatternToleranceAbsent ||
		filter.Wildcard.IsSet() || filter.Regex.IsSet() || len(wholeValueOperators(filter)) > 0
}

func (walk *filterWalk) requirePatternOperands(fieldPath string, filter *model.FieldFilter, field schema.ParsedFieldType) error {
	if filter.Contains.IsSet() {
		if err := requirePatternField(fieldPath, "contains", field); err != nil {
			return err
		}
	}
	if filter.CaseFold {
		if err := requirePatternField(fieldPath, "caseFold", field); err != nil {
			return err
		}
	}
	for _, named := range patternExpressionsOf(filter) {
		if !named.text.IsSet() {
			continue
		}
		if err := requirePatternField(fieldPath, named.operator, field); err != nil {
			return err
		}
	}
	if filter.Tolerance.Kind() != model.PatternToleranceAbsent {
		if err := requirePatternField(fieldPath, "tolerance", field); err != nil {
			return err
		}
	}
	if !field.Pattern || !holdsPatternOperand(filter) {
		return nil
	}
	if walk.patterns == nil {
		return missingPatternSearch(fieldPath)
	}
	return walk.patterns.CheckOperands(fieldPath, filter)
}
