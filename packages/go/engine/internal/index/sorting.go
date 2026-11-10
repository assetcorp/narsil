package index

import (
	"slices"
	"strconv"
	"strings"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/cursor"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partition"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/query"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

func quoted(value string) string {
	return `"` + value + `"`
}

func sortDirectionsOf(fields []model.SortField) []text.SortDirection {
	directions := make([]text.SortDirection, len(fields))
	for index, entry := range fields {
		directions[index] = text.SortDirection(entry.Direction)
	}
	return directions
}

func quotedSortModes() string {
	modes := text.SortModes()
	written := make([]string, len(modes))
	for index, mode := range modes {
		written[index] = quoted(string(mode))
	}
	return strings.Join(written, ", ")
}

func requireSortMode(entry model.SortField, fieldType string, declared bool) error {
	if entry.Mode == "" {
		return nil
	}
	if !text.IsSortMode(string(entry.Mode)) {
		return narsilerr.New(narsilerr.CodeSearchInvalidMode,
			"A sort mode is one of "+quotedSortModes()+", and the mode on "+quoted(entry.Field)+" is "+quoted(string(entry.Mode)),
			map[string]any{"field": entry.Field, "mode": string(entry.Mode)})
	}
	averages := entry.Mode == model.SortByMean || entry.Mode == model.SortByMedian
	if averages && declared && fieldType != string(model.FieldNumber) && fieldType != string(model.FieldNumberList) {
		return narsilerr.New(narsilerr.CodeSearchInvalidField,
			"The engine applies the "+quoted(string(entry.Mode))+" mode to a number field alone, and "+quoted(entry.Field)+" is a "+fieldType+" field",
			map[string]any{"field": entry.Field, "fieldType": fieldType, "mode": string(entry.Mode)})
	}
	return nil
}

func withSortableOption(parsed schema.ParsedFieldType) string {
	if parsed.Sortable {
		return string(parsed.Type)
	}
	written := string(parsed.Type)
	baseName, _, _ := strings.Cut(written, ":")
	widened, err := schema.ParseFieldType(baseName+":sortable"+written[len(baseName):], "")
	if err != nil {
		return written
	}
	return string(widened.Type)
}

func requireSortableType(entry model.SortField, field schema.Field) error {
	fieldType := string(field.Type)
	if field.IsStringValued() && !field.Sortable {
		return narsilerr.New(narsilerr.CodeSearchInvalidField,
			"The engine sorts by text field "+quoted(entry.Field)+" only where its type includes \"sortable\", as in "+quoted(withSortableOption(field.ParsedFieldType))+
				", because it keeps up to the first "+strconv.Itoa(text.SortValueMaxCodePoints)+" code points of every document's value in memory to sort by a text field",
			map[string]any{"field": entry.Field, "fieldType": fieldType})
	}
	if field.Base == schema.BaseGeopoint || field.Base == schema.BaseVector {
		return narsilerr.New(narsilerr.CodeSearchInvalidField,
			"The engine sorts by a number, boolean, enum, or sortable text field, and "+quoted(entry.Field)+" is a "+fieldType+" field",
			map[string]any{"field": entry.Field, "fieldType": fieldType})
	}
	return nil
}

func requireSortableFields(sort []model.SortField, parsed *schema.Parsed, strict bool) error {
	for _, entry := range sort {
		field, declared := parsed.Field(entry.Field)
		if strict && !declared {
			return undeclaredFieldOnStrictIndex(entry.Field, "sort")
		}
		if entry.Direction != model.SortAscending && entry.Direction != model.SortDescending {
			return narsilerr.New(narsilerr.CodeSearchInvalidMode,
				"A sort direction is \"asc\" or \"desc\", and the direction on "+quoted(entry.Field)+" is "+quoted(string(entry.Direction)),
				map[string]any{"field": entry.Field, "direction": string(entry.Direction)})
		}
		if err := requireSortMode(entry, string(field.Type), declared); err != nil {
			return err
		}
		if !declared {
			continue
		}
		if err := requireSortableType(entry, field); err != nil {
			return err
		}
	}
	return nil
}

type sortedRead struct {
	fields []model.SortField
	limit  int
	anchor *cursor.PageCursor
}

func (r sortedRead) request(partitionAt int, ids *recordedIDLookup) *query.SortRequest {
	request := &query.SortRequest{Fields: r.fields, Limit: r.limit, IDOf: ids.idAt, Partition: partitionAt}
	if r.anchor != nil {
		request.Anchor, request.AnchorID = r.anchor.SortKey, r.anchor.Anchor
		if request.Anchor == nil {
			request.Anchor = []text.SortValue{}
		}
	}
	return request
}

func sortedPages(views []*query.View, snapshots []partition.Snapshot, matched [][][]uint32, read sortedRead) ([][]query.SortedEntry, error) {
	pages := make([][]query.SortedEntry, 0, len(views)+1)
	for at, view := range views {
		ids := &recordedIDLookup{snapshot: snapshots[at]}
		request := read.request(at, ids)
		if matched != nil {
			if matched[at] == nil {
				continue
			}
			request.Matched = matched[at]
		}
		page, err := query.SortedPage(view, request)
		if err == nil {
			err = ids.err()
		}
		if err != nil {
			return nil, err
		}
		pages = append(pages, page)
	}
	return pages, nil
}

func mergedSortedPages(pages [][]query.SortedEntry, read sortedRead) ([]query.SortedEntry, error) {
	workspace, err := core.AcquireWorkspace()
	if err != nil {
		return nil, err
	}
	defer workspace.Release()
	return query.MergeSortedEntries(workspace, pages, sortDirectionsOf(read.fields), read.limit)
}

func sortedEntries(views []*query.View, snapshots []partition.Snapshot, matched [][][]uint32, read sortedRead) ([]query.SortedEntry, error) {
	pages, err := sortedPages(views, snapshots, matched, read)
	if err != nil {
		return nil, err
	}
	return mergedSortedPages(pages, read)
}

func missingSortKey(fields int) []text.SortValue {
	key := make([]text.SortValue, fields)
	for at := range key {
		key[at] = text.MissingSortValue()
	}
	return key
}

func (ix *Index) hitsInSortOrder(prepared *preparedQuery, hits []resultHit) ([]resultHit, map[string][]text.SortValue, error) {
	keys := make(map[string][]text.SortValue, len(hits))
	if len(hits) == 0 {
		return hits, keys, nil
	}
	views, err := prepared.reads.views.all()
	if err != nil {
		return nil, nil, err
	}
	snapshots := prepared.reads.reading.Snapshots
	matched := make([][][]uint32, len(views))
	for _, hit := range hits {
		at := ix.partitionOf(hit.ID)
		segment, ordinal, found, err := snapshots[at].Locate(hit.ID)
		if err != nil {
			return nil, nil, err
		}
		if !found {
			continue
		}
		if matched[at] == nil {
			matched[at] = query.MatchedSets(views[at])
		}
		query.MarkMatched(matched[at], segment, ordinal)
	}
	read := sortedRead{fields: prepared.params.Sort, limit: len(hits)}
	pages, err := sortedPages(views, snapshots, matched, read)
	if err != nil {
		return nil, nil, err
	}
	for _, page := range pages {
		for _, entry := range page {
			keys[entry.ID] = entry.Key
		}
	}
	var unplaced []query.SortedEntry
	byID := make(map[string]resultHit, len(hits))
	for _, hit := range hits {
		byID[hit.ID] = hit
		if _, placed := keys[hit.ID]; !placed {
			unplaced = append(unplaced, query.SortedEntry{ID: hit.ID, Key: missingSortKey(len(read.fields))})
		}
	}
	slices.SortFunc(unplaced, func(left, right query.SortedEntry) int { return text.CompareCodePoints(left.ID, right.ID) })
	for _, entry := range unplaced {
		keys[entry.ID] = entry.Key
	}
	merged, err := mergedSortedPages(append(pages, unplaced), read)
	if err != nil {
		return nil, nil, err
	}
	ordered := make([]resultHit, len(merged))
	for at, entry := range merged {
		ordered[at] = byID[entry.ID]
	}
	return ordered, keys, nil
}

func (ix *Index) withSortedPage(prepared *preparedQuery, views []*query.View, matched [][][]uint32, result *fanOutResult) error {
	read := sortedRead{fields: prepared.params.Sort, limit: prepared.offset + prepared.limit + 1}
	if encoded, set := prepared.params.SearchAfter.Get(); set {
		parsed, err := cursor.DecodePageCursor(encoded)
		if err != nil {
			return err
		}
		if err := cursor.RequireMatchingCursor(parsed, encoded, prepared.sortSignature, true, prepared.binding.Text()); err != nil {
			return err
		}
		read.anchor = &parsed
	}
	entries, err := sortedEntries(views, prepared.reads.reading.Snapshots, matched, read)
	if err != nil {
		return err
	}
	result.scored = make([]scoredHit, len(entries))
	result.sortKeys = make(map[string][]text.SortValue, len(entries))
	for at, entry := range entries {
		result.scored[at] = scoredHit{ID: entry.ID}
		result.sortKeys[entry.ID] = entry.Key
	}
	return nil
}
