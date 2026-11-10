package results

import (
	"fmt"
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type StoredValue struct {
	Value   any
	Present bool
}

type GroupedDocuments interface {
	FieldValues(id string, paths []string) []StoredValue
	Document(id string) (model.Document, bool)
}

type Group struct {
	Values       map[string]any
	Hits         []Hit
	Reduced      model.Optional[any]
	ReducerError model.Optional[string]
}

type ReducerRow struct {
	Document model.Document
	Found    bool
	Score    float64
}

type ReducerOutcome struct {
	Reduced      any
	ReducerError model.Optional[string]
}

const (
	missingReducerMessage      = "group.reduce.reducer is not a function"
	missingInitialValueMessage = "group.reduce.initialValue is not a function"
)

func HitsKeptPerGroup(maxPerGroup model.Optional[int]) int {
	kept, set := maxPerGroup.Get()
	if !set || kept < 1 {
		return defaultMaxPerGroup
	}
	return kept
}

func reducerFailureMessage(failure any) string {
	if typed, isNarsil := failure.(*narsilerr.Error); isNarsil && typed != nil {
		return typed.Message
	}
	if typed, isError := failure.(error); isError && typed != nil {
		return typed.Error()
	}
	return fmt.Sprint(failure)
}

func FoldGroupReducer(reduce model.GroupReducer, rows []ReducerRow) (outcome ReducerOutcome) {
	defer func() {
		if failure := recover(); failure != nil {
			outcome = ReducerOutcome{ReducerError: model.Some(reducerFailureMessage(failure))}
		}
	}()
	if reduce.InitialValue == nil {
		return ReducerOutcome{ReducerError: model.Some(missingInitialValueMessage)}
	}
	accumulator := reduce.InitialValue()
	for _, row := range rows {
		if !row.Found {
			continue
		}
		if reduce.Reduce == nil {
			return ReducerOutcome{ReducerError: model.Some(missingReducerMessage)}
		}
		next, err := reduce.Reduce(accumulator, row.Document, row.Score)
		if err != nil {
			return ReducerOutcome{ReducerError: model.Some(reducerFailureMessage(err))}
		}
		accumulator = next
	}
	return ReducerOutcome{Reduced: accumulator}
}

type pendingGroup struct {
	values map[string]any
	hits   []Hit
}

func collectGroups(hits []Hit, fields []string, documents GroupedDocuments) []*pendingGroup {
	byKey := map[string]*pendingGroup{}
	var ordered []*pendingGroup
	aligned := make([]StoredValue, len(fields))
	for _, hit := range hits {
		stored := documents.FieldValues(hit.ID, fields)
		for at := range fields {
			aligned[at] = StoredValue{}
			if at < len(stored) {
				aligned[at] = stored[at]
			}
		}
		key := groupKeyOf(aligned)
		if existing, found := byKey[key]; found {
			existing.hits = append(existing.hits, hit)
			continue
		}
		values := make(map[string]any, len(fields))
		for at, field := range fields {
			if aligned[at].Present {
				values[field] = aligned[at].Value
			} else {
				delete(values, field)
			}
		}
		group := &pendingGroup{values: values, hits: []Hit{hit}}
		byKey[key] = group
		ordered = append(ordered, group)
	}
	return ordered
}

func reducerRowsOf(hits []Hit, documents GroupedDocuments) []ReducerRow {
	rows := make([]ReducerRow, len(hits))
	for index, hit := range hits {
		document, found := documents.Document(hit.ID)
		rows[index] = ReducerRow{Document: document, Found: found, Score: scoreOrZero(hit)}
	}
	return rows
}

func compareGroups(left, right Group) int {
	leftScore, rightScore := 0.0, 0.0
	leftID, rightID := "", ""
	if len(left.Hits) > 0 {
		leftScore, leftID = scoreOrZero(left.Hits[0]), left.Hits[0].ID
	}
	if len(right.Hits) > 0 {
		rightScore, rightID = scoreOrZero(right.Hits[0]), right.Hits[0].ID
	}
	if leftScore != rightScore {
		return descendingScoreOrder(leftScore, rightScore)
	}
	return text.CompareCodePoints(leftID, rightID)
}

func ApplyGrouping(hits []Hit, group model.GroupConfig, documents GroupedDocuments) []Group {
	if len(group.Fields) == 0 {
		return []Group{{Values: map[string]any{}, Hits: hits}}
	}
	kept := HitsKeptPerGroup(group.MaxPerGroup)
	pending := collectGroups(hits, group.Fields, documents)
	groups := make([]Group, 0, len(pending))
	for _, entry := range pending {
		result := Group{Values: entry.values, Hits: append([]Hit(nil), entry.hits[:min(kept, len(entry.hits))]...)}
		if group.Reduce != nil {
			outcome := FoldGroupReducer(*group.Reduce, reducerRowsOf(entry.hits, documents))
			if outcome.ReducerError.IsSet() {
				result.ReducerError = outcome.ReducerError
			} else {
				result.Reduced = model.Some(outcome.Reduced)
			}
		}
		groups = append(groups, result)
	}
	slices.SortStableFunc(groups, compareGroups)
	if limit, set := group.Limit.Get(); set && limit >= 0 && len(groups) > limit {
		groups = groups[:limit]
	}
	return groups
}
