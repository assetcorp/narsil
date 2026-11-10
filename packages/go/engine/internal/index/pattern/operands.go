package pattern

import (
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

func invalidOperand(message, fieldPath, operator string) error {
	return narsilerr.New(narsilerr.CodeSearchInvalidFilter, message, map[string]any{"fieldPath": fieldPath, "operator": operator})
}

func requireWellFormed(fieldPath, operator, source string) error {
	if text.IsWellFormed(source) {
		return nil
	}
	return invalidOperand(`The text of "`+operator+`" on field "`+fieldPath+
		`" holds an unpaired surrogate, the half of a character such as an emoji whose other half is missing, so no stored value can hold it`,
		fieldPath, operator)
}

func requireWellFormedOperands(fieldPath string, filter *model.FieldFilter) error {
	wildcard, _ := filter.Wildcard.Get()
	regex, _ := filter.Regex.Get()
	named := append(testTextsOf(filter),
		namedTexts{operator: "wildcard", texts: []string{wildcard}}, namedTexts{operator: "regex", texts: []string{regex}},
		namedTexts{operator: "containsAll", texts: elementTexts(filter.ContainsAll)},
		namedTexts{operator: "matchesAny", texts: elementTexts(filter.MatchesAny)})
	for _, operand := range named {
		for _, source := range operand.texts {
			if err := requireWellFormed(fieldPath, operand.operator, source); err != nil {
				return err
			}
		}
	}
	return nil
}

func requireTextLength(fieldPath, operator, source string) error {
	if !text.ExceedsCodePoints(source, MaxTextCodePoints) {
		return nil
	}
	return invalidOperand(`The text of "`+operator+`" on pattern field "`+fieldPath+`" holds more than `+
		strconv.Itoa(MaxTextCodePoints)+" code points", fieldPath, operator)
}

func requirePatternText(fieldPath, operator, source string, caseFold bool) error {
	if err := requireTextLength(fieldPath, operator, source); err != nil {
		return err
	}
	if !caseFold || foldedCodePointCount(source) <= MaxPositions {
		return nil
	}
	limit := strconv.Itoa(MaxPositions)
	return invalidOperand(`The text of "`+operator+`" on pattern field "`+fieldPath+`" has a case fold of more than `+
		limit+" code points, while a pattern holds at most "+limit+" positions", fieldPath, operator)
}

func requireTolerance(fieldPath string, filter *model.FieldFilter) error {
	kind := filter.Tolerance.Kind()
	if kind == model.PatternToleranceAbsent {
		return nil
	}
	edits, _ := filter.Tolerance.Edits()
	if kind == model.PatternToleranceEdits && (edits < 0 || edits > MaxTolerance) {
		return invalidOperand(`"tolerance" on field "`+fieldPath+`" must be 0, 1, 2, or "auto"`, fieldPath, "tolerance")
	}
	eq, isText := filter.Eq.Text()
	if !isText {
		return invalidOperand(`"tolerance" applies only to an "eq" test, while the filter on field "`+fieldPath+
			`" sets no "eq" with text`, fieldPath, "tolerance")
	}
	if kind == model.PatternToleranceAuto || edits == 0 {
		return nil
	}
	prepared := foldTypoText(eq, nil)
	required := typoRunsNeeded(edits, prepared.longestFold)
	distinct := distinctTypoRunCount(prepared, required)
	if distinct >= required {
		return nil
	}
	return narsilerr.New(narsilerr.CodeSearchInvalidFilter,
		"A tolerance of "+strconv.Itoa(edits)+` on "eq" of pattern field "`+fieldPath+`" needs `+strconv.Itoa(required)+
			" distinct runs of three code points in the case fold of the text, while the text holds "+strconv.Itoa(distinct)+
			`. Lengthen the text, lower the tolerance, or set it to "auto"`,
		map[string]any{"fieldPath": fieldPath, "operator": "tolerance", "requiredRuns": required, "distinctRuns": distinct})
}

type namedTexts struct {
	operator string
	texts    []string
}

func testTextsOf(filter *model.FieldFilter) []namedTexts {
	single := func(operator string, source string, set bool) namedTexts {
		if !set {
			return namedTexts{operator: operator}
		}
		return namedTexts{operator: operator, texts: []string{source}}
	}
	eq, eqIsText := filter.Eq.Text()
	ne, neIsText := filter.Ne.Text()
	startsWith, startsWithSet := filter.StartsWith.Get()
	endsWith, endsWithSet := filter.EndsWith.Get()
	contains, containsSet := filter.Contains.Get()
	return []namedTexts{
		single("eq", eq, eqIsText), single("ne", ne, neIsText),
		{operator: "in", texts: filter.In}, {operator: "nin", texts: filter.Nin},
		single("startsWith", startsWith, startsWithSet), single("endsWith", endsWith, endsWithSet),
		single("contains", contains, containsSet),
	}
}

func elementTexts(values []model.FilterValue) []string {
	var texts []string
	for _, value := range values {
		if text, isText := value.Text(); isText {
			texts = append(texts, text)
		}
	}
	return texts
}

func CheckOperands(fieldPath string, filter *model.FieldFilter) error {
	if err := requireWellFormedOperands(fieldPath, filter); err != nil {
		return err
	}
	expressions := []struct {
		operator Operator
		value    model.Optional[string]
	}{{OperatorWildcard, filter.Wildcard}, {OperatorRegex, filter.Regex}}
	for _, expression := range expressions {
		source, set := expression.value.Get()
		if !set {
			continue
		}
		if err := requireTextLength(fieldPath, string(expression.operator), source); err != nil {
			return err
		}
		if err := CheckExpression(expression.operator, source, filter.CaseFold, fieldPath); err != nil {
			return err
		}
	}
	for _, named := range testTextsOf(filter) {
		for _, source := range named.texts {
			if err := requirePatternText(fieldPath, named.operator, source, filter.CaseFold); err != nil {
				return err
			}
		}
	}
	elements := []namedTexts{
		{operator: "matchesAny", texts: elementTexts(filter.MatchesAny)},
		{operator: "containsAll", texts: elementTexts(filter.ContainsAll)},
	}
	for _, named := range elements {
		for _, source := range named.texts {
			if err := requirePatternText(fieldPath, named.operator, source, false); err != nil {
				return err
			}
		}
	}
	return requireTolerance(fieldPath, filter)
}

func (search *Search) CheckOperands(fieldPath string, filter *model.FieldFilter) error {
	return CheckOperands(fieldPath, filter)
}
