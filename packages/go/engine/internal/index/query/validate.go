package query

import (
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

func invalidPhrase(message string, details map[string]any) error {
	return narsilerr.New(narsilerr.CodeSearchInvalidPhrase, message, details)
}

func validatePhrases(phrases []Phrase) error {
	if len(phrases) > MaxQueryPhrases {
		return invalidPhrase("The query holds more phrases than a search takes", map[string]any{"limit": MaxQueryPhrases, "phrases": len(phrases)})
	}
	for index := range phrases {
		phrase := &phrases[index]
		if len(phrase.Tokens) == 0 || len(phrase.Offsets) != len(phrase.Tokens) {
			return invalidPhrase("A phrase needs one offset for every token", map[string]any{"phrase": index})
		}
		if phrase.Offsets[0] != 0 {
			return invalidPhrase("A phrase starts at offset zero", map[string]any{"phrase": index})
		}
		for at := 1; at < len(phrase.Offsets); at++ {
			if phrase.Offsets[at] < phrase.Offsets[at-1] {
				return invalidPhrase("A phrase lists its offsets in ascending order", map[string]any{"phrase": index})
			}
		}
		words := max(len(phrase.Tokens), int(phrase.Offsets[len(phrase.Offsets)-1])+1)
		if len(phrase.Tokens) > MaxPhraseWords || phrase.Offsets[len(phrase.Offsets)-1] >= MaxPhraseWords {
			return invalidPhrase("A phrase holds more words than a search takes", map[string]any{"limit": MaxPhraseWords, "words": words})
		}
	}
	return nil
}

type PatternOperandCheck func(fieldPath string, filter *model.FieldFilter) error

type filterWalk struct {
	fields   *schema.Parsed
	patterns PatternOperandCheck
	tests    int
}

func ValidateFilter(root *model.FilterExpression, fields *schema.Parsed, patterns PatternOperandCheck) error {
	if root == nil {
		return nil
	}
	walk := &filterWalk{fields: fields, patterns: patterns}
	return walk.expression(root, 0)
}

func invalidFilterShape(message string) error {
	return narsilerr.New(narsilerr.CodeSearchInvalidFilter, message, nil)
}

func (walk *filterWalk) countTests(tests int) error {
	walk.tests += tests
	if walk.tests > MaxFilterTests {
		return invalidFilterShape("A filter holds at most " + strconv.Itoa(MaxFilterTests) + " tests across all of its fields and nested expressions")
	}
	return nil
}

func filterPathOrder(fields map[string]model.FieldFilter) []string {
	keys := make(map[string]any, len(fields))
	for path := range fields {
		keys[path] = nil
	}
	return codec.ObjectKeyOrder(keys)
}

func (walk *filterWalk) expression(source *model.FilterExpression, depth int) error {
	if depth > MaxFilterDepth {
		return invalidFilterShape("A filter expression nests at most " + strconv.Itoa(MaxFilterDepth) + " levels deep")
	}
	if len(source.Fields) == 0 && len(source.And) == 0 && len(source.Or) == 0 && source.Not == nil {
		if err := walk.countTests(1); err != nil {
			return err
		}
	}
	for _, path := range filterPathOrder(source.Fields) {
		filter := source.Fields[path]
		if err := walk.fieldTest(path, &filter); err != nil {
			return err
		}
	}
	for _, clause := range [][]model.FilterExpression{source.And, source.Or} {
		for at := range clause {
			if err := walk.expression(&clause[at], depth+1); err != nil {
				return err
			}
		}
	}
	if source.Not != nil {
		return walk.expression(source.Not, depth+1)
	}
	return nil
}

func (walk *filterWalk) fieldTest(path string, filter *model.FieldFilter) error {
	field, declared := walk.fields.Field(path)
	if !declared {
		return narsilerr.New(narsilerr.CodeSearchInvalidField,
			`The schema declares no field "`+path+`", while the engine answers a filter only from the indexes that it keeps for declared fields. Declare the field in the schema of a new index to filter by it`,
			map[string]any{"field": path, "option": "filter"})
	}
	if err := requireListLengths(path, filter); err != nil {
		return err
	}
	if err := walk.countTests(operatorTests(filter)); err != nil {
		return err
	}
	if err := requireWellFormedText(path, filter); err != nil {
		return err
	}
	checks := []func(string, *model.FieldFilter, schema.ParsedFieldType) error{
		requireRangeOperands, requireValueOperands, requireWholeValueIndex, requireElementOperands,
		requireSizeOperands, walk.requirePatternOperands, requireGeoOperands,
	}
	for _, check := range checks {
		if err := check(path, filter, field.ParsedFieldType); err != nil {
			return err
		}
	}
	return nil
}

func (walk *filterWalk) requirePatternOperands(fieldPath string, filter *model.FieldFilter, field schema.ParsedFieldType) error {
	single := []struct {
		operator string
		set      bool
	}{
		{"contains", filter.Contains.IsSet()}, {"caseFold", filter.CaseFold}, {"wildcard", filter.Wildcard.IsSet()},
		{"regex", filter.Regex.IsSet()}, {"tolerance", filter.Tolerance.Kind() != model.PatternToleranceAbsent},
	}
	for _, entry := range single {
		if entry.set && !field.Pattern {
			return invalidOperand(`"`+entry.operator+`" applies only to a pattern field, because only a pattern field has a pattern index. A pattern field is a "verbatim" field, or a text field whose type includes "pattern". Field "`+
				fieldPath+`" has type "`+string(field.Type)+`"`, fieldPath, entry.operator)
		}
	}
	holdsPattern := filter.Contains.IsSet() || filter.CaseFold || filter.Tolerance.Kind() != model.PatternToleranceAbsent ||
		filter.Wildcard.IsSet() || filter.Regex.IsSet() || len(wholeValueOperators(filter)) > 0
	if !field.Pattern || !holdsPattern {
		return nil
	}
	if walk.patterns == nil {
		return narsilerr.New(narsilerr.CodeConfigInvalid,
			`Field "`+fieldPath+`" is a pattern field, but this engine holds no pattern search code, so it cannot answer a filter on that field`,
			map[string]any{"field": fieldPath})
	}
	return walk.patterns(fieldPath, filter)
}
