package filters

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type namedRangeBound struct {
	operator string
	bound    model.RangeBound
}

type namedFilterValue struct {
	operator string
	value    model.FilterValue
}

type namedList struct {
	operator string
	values   []string
}

type namedText struct {
	operator string
	text     model.Optional[string]
}

type namedValueList struct {
	operator string
	values   []model.FilterValue
}

type namedSizeBound struct {
	operator string
	bound    model.Optional[float64]
}

func rangeBoundsOf(filter *model.FieldFilter) []namedRangeBound {
	return []namedRangeBound{{"gt", filter.Gt}, {"lt", filter.Lt}, {"gte", filter.Gte}, {"lte", filter.Lte}}
}

func equalitiesOf(filter *model.FieldFilter) []namedFilterValue {
	return []namedFilterValue{{"eq", filter.Eq}, {"ne", filter.Ne}}
}

func membershipsOf(filter *model.FieldFilter) []namedList {
	return []namedList{{"in", filter.In}, {"nin", filter.Nin}}
}

func affixesOf(filter *model.FieldFilter) []namedText {
	return []namedText{{"startsWith", filter.StartsWith}, {"endsWith", filter.EndsWith}}
}

func patternExpressionsOf(filter *model.FieldFilter) []namedText {
	return []namedText{{"wildcard", filter.Wildcard}, {"regex", filter.Regex}}
}

func elementListsOf(filter *model.FieldFilter) []namedValueList {
	return []namedValueList{{"matchesAny", filter.MatchesAny}, {"containsAll", filter.ContainsAll}}
}

func sizeBoundsOf(size *model.SizeFilter) []namedSizeBound {
	return []namedSizeBound{{"eq", size.Eq}, {"ne", size.Ne}, {"gt", size.Gt}, {"gte", size.Gte}, {"lt", size.Lt}, {"lte", size.Lte}}
}

func sizeTests(size *model.SizeFilter) int {
	tests := 0
	for _, named := range sizeBoundsOf(size) {
		if named.bound.IsSet() {
			tests++
		}
	}
	if size.Between.IsSet() {
		tests++
	}
	return max(1, tests)
}

func operatorTests(filter *model.FieldFilter) int {
	present := []bool{
		filter.Eq.IsSet(), filter.Ne.IsSet(), filter.Gt.IsSet(), filter.Lt.IsSet(), filter.Gte.IsSet(), filter.Lte.IsSet(),
		filter.Between.IsSet(), filter.In != nil, filter.Nin != nil, filter.StartsWith.IsSet(), filter.EndsWith.IsSet(),
		filter.Contains.IsSet(), filter.Wildcard.IsSet(), filter.Regex.IsSet(), filter.ContainsAll != nil, filter.MatchesAny != nil,
		filter.Exists.IsSet(), filter.NotExists.IsSet(), filter.IsEmpty.IsSet(), filter.IsNotEmpty.IsSet(),
		filter.Radius != nil, filter.Polygon != nil,
	}
	tests := 0
	for _, held := range present {
		if held {
			tests++
		}
	}
	if filter.Size != nil {
		tests += sizeTests(filter.Size)
	}
	return tests
}

func requireListLengths(fieldPath string, filter *model.FieldFilter) error {
	lengths := []struct {
		operator string
		held     bool
		length   int
	}{
		{"in", filter.In != nil, len(filter.In)},
		{"nin", filter.Nin != nil, len(filter.Nin)},
		{"containsAll", filter.ContainsAll != nil, len(filter.ContainsAll)},
		{"matchesAny", filter.MatchesAny != nil, len(filter.MatchesAny)},
		{"polygon", filter.Polygon != nil && filter.Polygon.Points != nil, polygonPointCount(filter.Polygon)},
	}
	for _, list := range lengths {
		if list.held && list.length > maxFilterListLength {
			return overlongList(fieldPath, list.operator, list.length)
		}
	}
	return nil
}

func polygonPointCount(polygon *model.GeoPolygon) int {
	if polygon == nil {
		return 0
	}
	return len(polygon.Points)
}

func malformed(candidate string, isText bool) bool {
	return isText && !text.IsWellFormed(candidate)
}

func malformedValue(value model.FilterValue) bool {
	return malformed(value.Text())
}

func malformedBound(bound model.RangeBound) bool {
	return malformed(bound.Text())
}

func malformedOptional(candidate model.Optional[string]) bool {
	return malformed(candidate.Get())
}

func malformedList(texts []string) bool {
	for _, candidate := range texts {
		if !text.IsWellFormed(candidate) {
			return true
		}
	}
	return false
}

func malformedValueList(values []model.FilterValue) bool {
	for _, value := range values {
		if malformedValue(value) {
			return true
		}
	}
	return false
}

func requireWellFormedText(fieldPath string, filter *model.FieldFilter) error {
	checks := []struct {
		operator  string
		malformed bool
	}{
		{"eq", malformedValue(filter.Eq)},
		{"ne", malformedValue(filter.Ne)},
		{"gt", malformedBound(filter.Gt)},
		{"lt", malformedBound(filter.Lt)},
		{"gte", malformedBound(filter.Gte)},
		{"lte", malformedBound(filter.Lte)},
		{"between", malformedBound(filter.Between.Low) || malformedBound(filter.Between.High)},
		{"in", malformedList(filter.In)},
		{"nin", malformedList(filter.Nin)},
		{"startsWith", malformedOptional(filter.StartsWith)},
		{"endsWith", malformedOptional(filter.EndsWith)},
		{"contains", malformedOptional(filter.Contains)},
		{"wildcard", malformedOptional(filter.Wildcard)},
		{"regex", malformedOptional(filter.Regex)},
		{"containsAll", malformedValueList(filter.ContainsAll)},
		{"matchesAny", malformedValueList(filter.MatchesAny)},
	}
	for _, check := range checks {
		if check.malformed {
			return unpairedSurrogate(fieldPath, check.operator)
		}
	}
	return nil
}
