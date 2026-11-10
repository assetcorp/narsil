package filters

import (
	"slices"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

type Filter struct {
	root     expression
	patterns PatternSearch
	types    map[string]schema.ParsedFieldType
}

type expression struct {
	fields []fieldTest
	and    []expression
	or     []expression
	not    *expression
}

type fieldTest struct {
	path   string
	field  schema.ParsedFieldType
	filter model.FieldFilter
}

type filterWalk struct {
	fields   *schema.Parsed
	patterns PatternSearch
	types    map[string]schema.ParsedFieldType
	tests    int
}

func Validate(root *model.FilterExpression, fields *schema.Parsed, patterns PatternSearch) (*Filter, error) {
	if root == nil {
		return nil, nil
	}
	walk := &filterWalk{fields: fields, patterns: patterns, types: map[string]schema.ParsedFieldType{}}
	validated, err := walk.expression(root, 0)
	if err != nil {
		return nil, err
	}
	return &Filter{root: validated, patterns: patterns, types: walk.types}, nil
}

func (walk *filterWalk) countTests(tests int) error {
	walk.tests += tests
	if walk.tests > maxFilterTests {
		return invalidShape("A filter holds at most " + strconv.Itoa(maxFilterTests) + " tests across all of its fields and nested expressions")
	}
	return nil
}

func holdsNestedExpressions(source *model.FilterExpression) bool {
	return len(source.And) > 0 || len(source.Or) > 0 || source.Not != nil
}

func fieldPathOrder(fields map[string]model.FieldFilter) []string {
	keys := make(map[string]any, len(fields))
	for path := range fields {
		keys[path] = nil
	}
	return codec.ObjectKeyOrder(keys)
}

func (walk *filterWalk) expression(source *model.FilterExpression, depth int) (expression, error) {
	if depth > maxFilterDepth {
		return expression{}, invalidShape("A filter expression nests at most " + strconv.Itoa(maxFilterDepth) + " levels deep")
	}
	if len(source.Fields) == 0 && !holdsNestedExpressions(source) {
		if err := walk.countTests(1); err != nil {
			return expression{}, err
		}
	}
	var validated expression
	for _, path := range fieldPathOrder(source.Fields) {
		test, err := walk.fieldTest(path, source.Fields[path])
		if err != nil {
			return expression{}, err
		}
		validated.fields = append(validated.fields, test)
	}
	var err error
	if validated.and, err = walk.clause(source.And, depth); err != nil {
		return expression{}, err
	}
	if validated.or, err = walk.clause(source.Or, depth); err != nil {
		return expression{}, err
	}
	if source.Not != nil {
		excluded, err := walk.expression(source.Not, depth+1)
		if err != nil {
			return expression{}, err
		}
		validated.not = &excluded
	}
	return validated, nil
}

func (walk *filterWalk) clause(list []model.FilterExpression, depth int) ([]expression, error) {
	if len(list) == 0 {
		return nil, nil
	}
	validated := make([]expression, 0, len(list))
	for at := range list {
		nested, err := walk.expression(&list[at], depth+1)
		if err != nil {
			return nil, err
		}
		validated = append(validated, nested)
	}
	return validated, nil
}

func (walk *filterWalk) fieldTest(path string, filter model.FieldFilter) (fieldTest, error) {
	field, declared := walk.fields.Field(path)
	if !declared {
		return fieldTest{}, undeclaredFilterField(path)
	}
	if err := requireListLengths(path, &filter); err != nil {
		return fieldTest{}, err
	}
	if err := walk.countTests(max(1, operatorTests(&filter))); err != nil {
		return fieldTest{}, err
	}
	if err := requireWellFormedText(path, &filter); err != nil {
		return fieldTest{}, err
	}
	if err := walk.requireValidOperands(path, &filter, field.ParsedFieldType); err != nil {
		return fieldTest{}, err
	}
	walk.types[path] = field.ParsedFieldType
	return fieldTest{path: path, field: field.ParsedFieldType, filter: ownedFieldFilter(filter)}, nil
}

func (walk *filterWalk) requireValidOperands(path string, filter *model.FieldFilter, field schema.ParsedFieldType) error {
	checks := []func(string, *model.FieldFilter, schema.ParsedFieldType) error{
		requireRangeOperands,
		requireValueOperands,
		requireWholeValueIndex,
		requireElementOperands,
		requireSizeOperands,
		walk.requirePatternOperands,
		requireGeoOperands,
	}
	for _, check := range checks {
		if err := check(path, filter, field); err != nil {
			return err
		}
	}
	return nil
}

func ownedFieldFilter(filter model.FieldFilter) model.FieldFilter {
	filter.In = slices.Clone(filter.In)
	filter.Nin = slices.Clone(filter.Nin)
	filter.ContainsAll = slices.Clone(filter.ContainsAll)
	filter.MatchesAny = slices.Clone(filter.MatchesAny)
	if filter.Size != nil {
		size := *filter.Size
		filter.Size = &size
	}
	if filter.Radius != nil {
		radius := *filter.Radius
		filter.Radius = &radius
	}
	if filter.Polygon != nil {
		polygon := *filter.Polygon
		polygon.Points = slices.Clone(polygon.Points)
		filter.Polygon = &polygon
	}
	return filter
}
