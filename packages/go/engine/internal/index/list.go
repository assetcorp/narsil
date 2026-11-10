package index

import (
	"cmp"
	"context"
	"sort"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/cursor"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partition"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/projection"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/query"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type listedEntry struct {
	id       string
	key      []text.SortValue
	document *codec.Document
}

type listRequest struct {
	limit      int
	anchor     *cursor.PageCursor
	sort       []model.SortField
	sorted     bool
	directions []text.SortDirection
}

type listedSet struct {
	snapshot partition.Snapshot
	accepted map[string]struct{}
	filtered bool
}

func (s *listedSet) accepts(id string) bool {
	if !s.filtered {
		return true
	}
	_, held := s.accepted[id]
	return held
}

func listedSetOf(snapshot partition.Snapshot, view *query.View, filters *filterRun) (*listedSet, int, error) {
	set := &listedSet{snapshot: snapshot}
	if filters == nil {
		return set, snapshot.Count(), nil
	}
	matched, err := filters.evaluate(view)
	if err != nil {
		return nil, 0, err
	}
	ids := matchingIDs(snapshot, matched)
	set.filtered = true
	set.accepted = make(map[string]struct{}, len(ids))
	for _, id := range ids {
		set.accepted[id] = struct{}{}
	}
	return set, len(ids), nil
}

func entriesInIDOrder(set *listedSet, request *listRequest) ([]listedEntry, error) {
	ids := set.snapshot.SortedIDs()
	start := 0
	if request.anchor != nil {
		anchor := request.anchor.Anchor
		start = sort.Search(len(ids), func(at int) bool { return text.CompareCodePoints(ids[at], anchor) > 0 })
	}
	var entries []listedEntry
	for at := start; at < len(ids) && len(entries) <= request.limit; at++ {
		if !set.accepts(ids[at]) {
			continue
		}
		document, found, err := set.snapshot.Document(ids[at])
		if err != nil {
			return nil, err
		}
		if found {
			entries = append(entries, listedEntry{id: ids[at], document: document})
		}
	}
	return entries, nil
}

func entriesInSortOrder(set *listedSet, request *listRequest) ([]listedEntry, error) {
	fields := sortFieldNames(request.sort)
	modes := sortModesOf(request.sort)
	var entries []listedEntry
	var failure error
	err := set.snapshot.EachDocument(func(id string, document *codec.Document) bool {
		if !set.accepts(id) {
			return true
		}
		if failure = codec.DocumentFailure(document); failure != nil {
			return false
		}
		entry := listedEntry{id: id, key: readSortValues(document, fields, modes), document: document}
		if request.anchor != nil && compareListed(entry, listedEntry{id: request.anchor.Anchor, key: request.anchor.SortKey}, request.directions) <= 0 {
			return true
		}
		entries = append(entries, entry)
		return true
	})
	if err = cmp.Or(err, failure); err != nil {
		return nil, err
	}
	sortListed(entries, request.directions)
	if len(entries) > request.limit+1 {
		entries = entries[:request.limit+1]
	}
	return entries, nil
}

func compareListed(left, right listedEntry, directions []text.SortDirection) int {
	if comparison := text.CompareComparableKeys(left.key, right.key, directions); comparison != 0 {
		return comparison
	}
	return text.CompareCodePoints(left.id, right.id)
}

func sortListed(entries []listedEntry, directions []text.SortDirection) {
	sort.SliceStable(entries, func(left, right int) bool { return compareListed(entries[left], entries[right], directions) < 0 })
}

func (ix *Index) listRequestOf(params *model.ListParams, limit int, signature model.Optional[string], binding string) (*listRequest, error) {
	request := &listRequest{limit: limit, sort: params.Sort, sorted: params.Sort != nil && signature.IsSet()}
	if request.sorted {
		request.directions = sortDirectionsOf(params.Sort)
	}
	if encoded, set := params.Cursor.Get(); set {
		decoded, err := cursor.DecodePageCursor(encoded)
		if err != nil {
			return nil, err
		}
		if err := cursor.RequireMatchingCursor(decoded, encoded, signature, false, binding); err != nil {
			return nil, err
		}
		request.anchor = &decoded
	}
	return request, nil
}

func (ix *Index) listEntries(ctx context.Context, params *model.ListParams, request *listRequest) ([]listedEntry, int, error) {
	work, closeWork, err := openWorkMeter(ctx, ix.settings.SearchWorkCap)
	if err != nil {
		return nil, 0, err
	}
	defer closeWork()
	prepared := &preparedQuery{params: model.QueryParams{Filters: params.Filters}, work: work, ctx: ctx}
	if err := ix.openReads(prepared, nil); err != nil {
		return nil, 0, err
	}
	defer prepared.reads.release()
	views, err := prepared.reads.views.all()
	if err != nil {
		return nil, 0, err
	}
	total := 0
	var entries []listedEntry
	for at, snapshot := range prepared.reads.reading.Snapshots {
		set, count, err := listedSetOf(snapshot, views[at], prepared.filters)
		if err != nil {
			return nil, 0, err
		}
		total += count
		var found []listedEntry
		if request.sorted {
			found, err = entriesInSortOrder(set, request)
		} else {
			found, err = entriesInIDOrder(set, request)
		}
		if err != nil {
			return nil, 0, err
		}
		entries = append(entries, found...)
	}
	return entries, total, nil
}

func (ix *Index) List(ctx context.Context, params model.ListParams) (model.ListResult, error) {
	started := time.Now()
	limit := max(1, cursor.ClampLimit(params.Limit))
	if err := cursor.RequireWithinResultWindow(limit, 0); err != nil {
		return model.ListResult{}, err
	}
	signature, err := cursor.SortSignatureOf(params.Sort)
	if err != nil {
		return model.ListResult{}, err
	}
	if err := requireSortableFields(params.Sort, ix.settings.Schema, ix.settings.Strict); err != nil {
		return model.ListResult{}, err
	}
	if err := ix.validateFilter(params.Filters); err != nil {
		return model.ListResult{}, err
	}
	shown := projection.Resolve(params.Document)
	binding := cursor.ListBindingOf(params.Filters)
	request, err := ix.listRequestOf(&params, limit, signature, binding)
	if err != nil {
		return model.ListResult{}, err
	}
	entries, total, err := ix.listEntries(ctx, &params, request)
	if err != nil {
		return model.ListResult{}, stoppedSearchFailure(ctx, err)
	}
	sortListed(entries, request.directions)
	result := model.ListResult{Total: total, Documents: []model.ListedDocument{}}
	if len(entries) > limit {
		entries = entries[:limit]
		last := entries[len(entries)-1]
		next := cursor.PageCursor{Anchor: last.id, Binding: binding}
		if request.sorted {
			next.SortKey, next.SortSignature = last.key, signature
		}
		result.Cursor = cursor.EncodePageCursor(next)
	}
	for _, entry := range entries {
		document := entry.document
		if shown.Kind() != model.ProjectWholeDocument {
			if err := codec.DocumentFailure(entry.document); err != nil {
				return model.ListResult{}, err
			}
			document = shown.Clone(entry.document)
		}
		result.Documents = append(result.Documents, model.ListedDocument{ID: entry.id, Document: document})
	}
	result.Elapsed = time.Since(started)
	return result, nil
}
