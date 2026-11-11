package index

import (
	"context"
	"slices"
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
	limit  int
	anchor *cursor.PageCursor
	sort   []model.SortField
	sorted bool
}

type listedSet struct {
	snapshot partition.Snapshot
	accepted map[string]struct{}
	matched  [][]uint32
	filtered bool
}

func (s *listedSet) accepts(id string) bool {
	if !s.filtered {
		return true
	}
	_, held := s.accepted[id]
	return held
}

func countMatching(snapshot partition.Snapshot, matched [][]uint32) int {
	count := 0
	for segment, words := range matched {
		eachOrdinal(words, func(ordinal uint32) {
			if snapshot.Live(segment, ordinal) {
				count++
			}
		})
	}
	return count
}

func listedSetOf(snapshot partition.Snapshot, view *query.View, filters *filterRun, sorted bool) (*listedSet, int, error) {
	set := &listedSet{snapshot: snapshot}
	if filters == nil {
		return set, snapshot.Count(), nil
	}
	matched, err := filters.evaluate(view)
	if err != nil {
		return nil, 0, err
	}
	set.filtered, set.matched = true, matched
	if sorted {
		return set, countMatching(snapshot, matched), nil
	}
	ids, err := matchingIDs(snapshot, matched)
	if err != nil {
		return nil, 0, err
	}
	set.accepted = make(map[string]struct{}, len(ids))
	for _, id := range ids {
		set.accepted[id] = struct{}{}
	}
	return set, len(ids), nil
}

func entriesInIDOrder(set *listedSet, request *listRequest) ([]listedEntry, error) {
	ids, err := set.snapshot.SortedIDs()
	if err != nil {
		return nil, err
	}
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

func entriesInSortOrder(views []*query.View, snapshots []partition.Snapshot, matched [][][]uint32, request *listRequest) ([]listedEntry, error) {
	read := sortedRead{fields: request.sort, limit: request.limit + 1, anchor: request.anchor}
	found, err := sortedEntries(views, snapshots, matched, read)
	if err != nil {
		return nil, err
	}
	entries := make([]listedEntry, 0, len(found))
	for _, entry := range found {
		document, held, err := snapshots[entry.Partition].Document(entry.ID)
		if err != nil {
			return nil, err
		}
		if held {
			entries = append(entries, listedEntry{id: entry.ID, key: entry.Key, document: document})
		}
	}
	return entries, nil
}

func (ix *Index) listRequestOf(params *model.ListParams, limit int, signature model.Optional[string], binding string) (*listRequest, error) {
	request := &listRequest{limit: limit, sort: params.Sort, sorted: len(params.Sort) > 0 && signature.IsSet()}
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
	if err := ctx.Err(); err != nil {
		return nil, 0, err
	}
	work := query.NewWork(ctx, ix.settings.SearchWorkCap)
	defer work.Close()
	prepared := &preparedQuery{params: model.QueryParams{Filters: params.Filters}, work: work, ctx: ctx}
	if request.sorted {
		prepared.params.Sort = request.sort
	}
	if err := ix.openReads(prepared, nil); err != nil {
		return nil, 0, err
	}
	defer prepared.reads.release()
	views, err := prepared.reads.views.all()
	if err != nil {
		return nil, 0, err
	}
	snapshots := prepared.reads.reading.Snapshots
	var matched [][][]uint32
	if request.sorted && prepared.filters != nil {
		matched = make([][][]uint32, len(snapshots))
	}
	total := 0
	var entries []listedEntry
	for at, snapshot := range snapshots {
		set, count, err := listedSetOf(snapshot, views[at], prepared.filters, request.sorted)
		if err != nil {
			return nil, 0, err
		}
		total += count
		if request.sorted {
			if matched != nil {
				matched[at] = set.matched
			}
			continue
		}
		found, err := entriesInIDOrder(set, request)
		if err != nil {
			return nil, 0, err
		}
		entries = append(entries, found...)
	}
	if request.sorted {
		entries, err = entriesInSortOrder(views, snapshots, matched, request)
		return entries, total, err
	}
	slices.SortFunc(entries, func(left, right listedEntry) int { return text.CompareCodePoints(left.id, right.id) })
	return entries[:min(len(entries), request.limit+1)], total, nil
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
		if err := shown.Failure(entry.document); err != nil {
			return model.ListResult{}, err
		}
		if shown.Kind() != model.ProjectWholeDocument {
			document = shown.Clone(entry.document)
		}
		result.Documents = append(result.Documents, model.ListedDocument{ID: entry.id, Document: document})
	}
	result.Elapsed = time.Since(started)
	return result, nil
}
