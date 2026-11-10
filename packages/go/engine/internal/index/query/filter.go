package query

import (
	"context"
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

type FilterRun struct {
	workspace *core.Workspace
	work      *Work
	ownWork   bool
	claimed   map[string]bool
}

func NewFilterRun(work *Work) (*FilterRun, error) {
	workspace, err := core.AcquireWorkspace()
	if err != nil {
		return nil, err
	}
	run := &FilterRun{workspace: workspace, work: work, claimed: map[string]bool{}}
	if work == nil {
		run.work, run.ownWork = NewWork(context.Background(), DefaultPatternWorkCap), true
	}
	return run, nil
}

func (r *FilterRun) Release() {
	if r.ownWork {
		r.work.Close()
	}
	r.workspace.Release()
}

func invalidFilter(message string) error {
	return narsilerr.New(narsilerr.CodeSearchInvalidFilter, message, nil)
}

func operatorTests(filter *model.FieldFilter) int {
	tests := 0
	for _, set := range []bool{
		filter.Eq.IsSet(), filter.Ne.IsSet(), filter.Gt.IsSet(), filter.Lt.IsSet(), filter.Gte.IsSet(), filter.Lte.IsSet(),
		filter.Between.IsSet(), filter.In != nil, filter.Nin != nil, filter.StartsWith.IsSet(), filter.EndsWith.IsSet(),
		filter.Contains.IsSet(), filter.Wildcard.IsSet(), filter.Regex.IsSet(), filter.ContainsAll != nil,
		filter.MatchesAny != nil, filter.Exists.IsSet(), filter.NotExists.IsSet(), filter.IsEmpty.IsSet(),
		filter.IsNotEmpty.IsSet(), filter.Radius != nil, filter.Polygon != nil,
	} {
		if set {
			tests++
		}
	}
	if size := filter.Size; size != nil {
		keys := 0
		for _, set := range []bool{size.Eq.IsSet(), size.Ne.IsSet(), size.Gt.IsSet(), size.Lt.IsSet(), size.Gte.IsSet(), size.Lte.IsSet(), size.Between.IsSet()} {
			if set {
				keys++
			}
		}
		tests += max(1, keys)
	}
	return max(1, tests)
}

func listsWithinLimit(filter *model.FieldFilter) bool {
	lengths := []int{len(filter.In), len(filter.Nin), len(filter.ContainsAll), len(filter.MatchesAny)}
	if filter.Polygon != nil {
		lengths = append(lengths, len(filter.Polygon.Points))
	}
	for _, length := range lengths {
		if length > MaxFilterListItems {
			return false
		}
	}
	return true
}

func checkFilter(expression *model.FilterExpression, types map[string]schema.ParsedFieldType, depth int, tests *int) error {
	if depth > MaxFilterDepth {
		return invalidFilter("A filter expression nests deeper than a search takes")
	}
	if len(expression.Fields) == 0 && len(expression.And) == 0 && len(expression.Or) == 0 && expression.Not == nil {
		*tests++
	}
	for path, filter := range expression.Fields {
		if _, declared := types[path]; !declared {
			return narsilerr.New(narsilerr.CodeSearchInvalidField, "The schema declares no field that this filter names", map[string]any{"field": path, "option": "filter"})
		}
		if !listsWithinLimit(&filter) {
			return invalidFilter("A filter list holds more items than a search takes")
		}
		*tests += operatorTests(&filter)
	}
	if *tests > MaxFilterTests {
		return invalidFilter("A filter holds more tests than a search takes")
	}
	for _, nested := range [][]model.FilterExpression{expression.And, expression.Or} {
		for at := range nested {
			if err := checkFilter(&nested[at], types, depth+1, tests); err != nil {
				return err
			}
		}
	}
	if expression.Not != nil {
		return checkFilter(expression.Not, types, depth+1, tests)
	}
	return nil
}

func sortedPaths(fields map[string]model.FieldFilter) []string {
	paths := make([]string, 0, len(fields))
	for path := range fields {
		paths = append(paths, path)
	}
	slices.Sort(paths)
	return paths
}

func (b *filterBuilder) expressionPlan(expression *model.FilterExpression) error {
	count := 0
	appended := func() {
		if count != 0 {
			b.emit(core.FilterAnd, 0, 0, 2)
		}
		count++
	}
	for _, path := range sortedPaths(expression.Fields) {
		filter := expression.Fields[path]
		if err := b.fieldPlan(path, &filter, b.types[path]); err != nil {
			return err
		}
		appended()
	}
	for at := range expression.And {
		if err := b.expressionPlan(&expression.And[at]); err != nil {
			return err
		}
		appended()
	}
	for at := range expression.Or {
		if err := b.expressionPlan(&expression.Or[at]); err != nil {
			return err
		}
		if at != 0 {
			b.emit(core.FilterOr, 0, 0, 2)
		}
	}
	if len(expression.Or) > 0 {
		appended()
	}
	if expression.Not != nil {
		if err := b.expressionPlan(expression.Not); err != nil {
			return err
		}
		b.emit(core.FilterNot, 0, 0, 0)
		appended()
	}
	if count == 0 {
		b.bitset(b.live)
	}
	return nil
}

func (r *FilterRun) Evaluate(view *View, expression *model.FilterExpression) ([][]uint32, error) {
	if err := validateView(view); err != nil {
		return nil, err
	}
	if expression == nil {
		return nil, invalidFilter("The filter expression is missing")
	}
	tests := 0
	if err := checkFilter(expression, view.Schema, 0, &tests); err != nil {
		return nil, err
	}
	matched := make([][]uint32, len(view.Segments))
	for index := range view.Segments {
		segment := &view.Segments[index]
		live, err := segment.liveBits()
		if err != nil {
			return nil, err
		}
		builder := &filterBuilder{
			run: r, segment: segment, types: view.Schema, capacity: segment.capacity(), live: live,
			ids: map[filterField]int{}, present: map[string][]uint32{},
		}
		if err := builder.expressionPlan(expression); err != nil {
			return nil, err
		}
		program, err := builder.program()
		if err != nil {
			return nil, err
		}
		matched[index] = newBits(builder.capacity)
		if err := r.workspace.EvaluateFilter(program, matched[index]); err != nil {
			return nil, narsilerr.Wrap(narsilerr.CodeConfigInvalid, "The filter plan cannot be evaluated", err, nil)
		}
	}
	return matched, nil
}

func holdsTextRange(filter *model.FieldFilter) bool {
	_, text := filter.Between.Low.Text()
	for _, bound := range []model.RangeBound{filter.Gt, filter.Gte, filter.Lt, filter.Lte} {
		_, isText := bound.Text()
		text = text || isText
	}
	return text
}

func FilterSortFields(expression *model.FilterExpression) []string {
	return filteredFields(expression, holdsTextRange)
}

func FilteredFields(expression *model.FilterExpression) []string {
	return filteredFields(expression, func(*model.FieldFilter) bool { return true })
}

func filteredFields(expression *model.FilterExpression, wanted func(filter *model.FieldFilter) bool) []string {
	var fields []string
	var walk func(expression *model.FilterExpression)
	walk = func(expression *model.FilterExpression) {
		for path, filter := range expression.Fields {
			if wanted(&filter) && !slices.Contains(fields, path) {
				fields = append(fields, path)
			}
		}
		for at := range expression.And {
			walk(&expression.And[at])
		}
		for at := range expression.Or {
			walk(&expression.Or[at])
		}
		if expression.Not != nil {
			walk(expression.Not)
		}
	}
	if expression != nil {
		walk(expression)
	}
	slices.Sort(fields)
	return fields
}
