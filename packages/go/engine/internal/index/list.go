package index

import (
	"sort"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/bitset"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/cursor"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partition"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/projection"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/results"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type listedEntry struct {
	id       string
	key      []text.SortValue
	document *partition.StoredDocument
}

type listRequest struct {
	limit      int
	anchor     *cursor.PageCursor
	filter     *partitionFilter
	sort       []model.SortField
	sorted     bool
	directions []text.SortDirection
}

func (ix *Index) listMatches(view partition.View, filter *partitionFilter) (bitset.Bits, int, error) {
	if filter == nil {
		return nil, view.Count(), nil
	}
	accepted, err := filter.matches(view)
	if err != nil {
		return nil, 0, err
	}
	live := view.Live()
	count := 0
	accepted.ForEach(func(ordinal uint32) bool {
		if live.Has(ordinal) {
			count++
		}
		return true
	})
	return accepted, count, nil
}

func (ix *Index) entriesInIDOrder(view partition.View, accepted bitset.Bits, request *listRequest) []listedEntry {
	ids := view.SortedDocumentIDs()
	start := 0
	if request.anchor != nil {
		anchor := request.anchor.Anchor
		start = sort.Search(len(ids), func(at int) bool { return text.CompareCodePoints(ids[at], anchor) > 0 })
	}
	var entries []listedEntry
	for at := start; at < len(ids) && len(entries) <= request.limit; at++ {
		document, ordinal, found := view.Document(ids[at])
		if !found || accepted != nil && !accepted.Has(ordinal) {
			continue
		}
		entries = append(entries, listedEntry{id: ids[at], document: document})
	}
	return entries
}

func (ix *Index) entriesInSortOrder(view partition.View, accepted bitset.Bits, request *listRequest) []listedEntry {
	fields := sortFieldNames(request.sort)
	modes := results.SortModesOf(request.sort)
	var entries []listedEntry
	view.ForEachDocument(func(ordinal uint32, document *partition.StoredDocument) bool {
		if accepted != nil && !accepted.Has(ordinal) {
			return true
		}
		entry := listedEntry{id: document.ID, key: ix.sortValuesOf(document, fields, modes), document: document}
		if request.anchor != nil && compareListed(entry, listedEntry{id: request.anchor.Anchor, key: request.anchor.SortKey}, request.directions) <= 0 {
			return true
		}
		entries = append(entries, entry)
		return true
	})
	sortListed(entries, request.directions)
	if len(entries) > request.limit+1 {
		entries = entries[:request.limit+1]
	}
	return entries
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

func (ix *Index) List(params model.ListParams) (model.ListResult, error) {
	started := time.Now()
	limit := max(1, cursor.ClampLimit(params.Limit))
	if err := cursor.RequireWithinResultWindow(limit, 0); err != nil {
		return model.ListResult{}, err
	}
	signature, err := cursor.SortSignatureOf(params.Sort)
	if err != nil {
		return model.ListResult{}, err
	}
	if err := results.RequireSortableFields(params.Sort, ix.settings.Schema, ix.settings.Strict); err != nil {
		return model.ListResult{}, err
	}
	filter, err := ix.compileFilter(params.Filters, partition.NewWorkMeter(ix.settings.SearchWorkCap))
	if err != nil {
		return model.ListResult{}, err
	}
	shown := projection.Resolve(params.Document)
	binding := cursor.ListBindingOf(params.Filters)
	request := &listRequest{limit: limit, filter: filter, sort: params.Sort, sorted: params.Sort != nil && signature.IsSet()}
	if request.sorted {
		request.directions = results.SortDirectionsOf(params.Sort)
	}
	if encoded, set := params.Cursor.Get(); set {
		decoded, err := cursor.DecodePageCursor(encoded)
		if err != nil {
			return model.ListResult{}, err
		}
		if err := cursor.RequireMatchingCursor(decoded, encoded, signature, false, binding); err != nil {
			return model.ListResult{}, err
		}
		request.anchor = &decoded
	}
	held := ix.acquireAll(ix.allPartitionIDs())
	defer held.release()
	total := 0
	var entries []listedEntry
	for _, view := range held.partitions {
		accepted, count, err := ix.listMatches(view, filter)
		if err != nil {
			return model.ListResult{}, err
		}
		total += count
		if request.sorted {
			entries = append(entries, ix.entriesInSortOrder(view, accepted, request)...)
			continue
		}
		entries = append(entries, ix.entriesInIDOrder(view, accepted, request)...)
	}
	sortListed(entries, request.directions)
	result := model.ListResult{Total: total, Documents: []model.ListedDocument{}}
	hasMore := len(entries) > limit
	if hasMore {
		entries = entries[:limit]
		last := entries[len(entries)-1]
		next := cursor.PageCursor{Anchor: last.id, Binding: binding}
		if request.sorted {
			next.SortKey, next.SortSignature = last.key, signature
		}
		result.Cursor = cursor.EncodePageCursor(next)
	}
	for _, entry := range entries {
		document := model.Document{}
		if shown.Kind() != model.ProjectNoFields {
			document = shown.Clone(entry.document.Fields)
		}
		result.Documents = append(result.Documents, model.ListedDocument{ID: entry.id, Document: document})
	}
	result.Elapsed = time.Since(started)
	return result, nil
}
