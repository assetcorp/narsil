package engine_test

import (
	"cmp"
	"context"
	"errors"
	"slices"
	"strconv"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	pantryIndexName      = "pantry"
	pantryPartitions     = 3
	pantryFrozenItems    = 90
	pantryGrowingItems   = 30
	pantryPriceSpread    = 13
	pantryPriceStep      = 7
	pantryMissingStride  = 11
	pantryUnmarkedStride = 4
	pantryRemovalStride  = 7
	pantryRepriceStride  = 5
	pantryRepriceShift   = 3
	pantrySizeSpread     = 9
	pantryPage           = 7
	pantryOffset         = 10
	pantryWholeLimit     = 500
	pantryListFloor      = 3
	pantryRaisedPrice    = 1_000
	pantryMarker         = "crate"
	pantryOther          = "barrel"
	pantryWideID         = "ｚ-item"
	pantryAstralID       = "\U0001f600-item"
)

var pantryKinds = []string{"oak", "pine", "ash"}

type pantryItem struct {
	id     string
	price  float64
	priced bool
	sizes  []float64
	kind   string
	marked bool
}

type pantryOrder struct {
	field string
	desc  bool
	mean  bool
}

func pantryItemOf(at int) pantryItem {
	item := pantryItem{id: "item-" + strconv.Itoa(1000+at), kind: pantryKinds[at%len(pantryKinds)], marked: at%pantryUnmarkedStride != 0}
	switch at {
	case 2:
		item.id = pantryWideID
	case 2 + pantryPriceSpread:
		item.id = pantryAstralID
	}
	if at%pantryMissingStride != 0 {
		item.price, item.priced = float64((at*pantryPriceStep)%pantryPriceSpread), true
	}
	for k := range 1 << (at % 3) {
		item.sizes = append(item.sizes, float64((at+k*3)%pantrySizeSpread))
	}
	return item
}

func (item pantryItem) document() *engine.Document {
	title := pantryOther
	if item.marked {
		title = pantryMarker
	}
	sizes := make([]any, len(item.sizes))
	for at, size := range item.sizes {
		sizes[at] = size
	}
	record := map[string]any{"id": item.id, "title": title + " pantry", "kind": item.kind, "sizes": sizes}
	if item.priced {
		record["price"] = item.price
	}
	return engine.DocumentFromMap(record)
}

func (item pantryItem) sortValue(order pantryOrder) (float64, bool) {
	if order.field == "price" {
		return item.price, item.priced
	}
	switch {
	case order.mean:
		total := 0.0
		for _, size := range item.sizes {
			total += size
		}
		return total / float64(len(item.sizes)), true
	case order.desc:
		return slices.Max(item.sizes), true
	}
	return slices.Min(item.sizes), true
}

func expectedPantryOrder(items map[string]pantryItem, keep func(pantryItem) bool, orders []pantryOrder) []string {
	var kept []pantryItem
	for _, item := range items {
		if keep(item) {
			kept = append(kept, item)
		}
	}
	slices.SortFunc(kept, func(left, right pantryItem) int {
		for _, order := range orders {
			leftValue, leftHeld := left.sortValue(order)
			rightValue, rightHeld := right.sortValue(order)
			switch {
			case !leftHeld && !rightHeld:
				continue
			case !leftHeld:
				return 1
			case !rightHeld:
				return -1
			}
			if comparison := cmp.Compare(leftValue, rightValue); comparison != 0 {
				if order.desc {
					return -comparison
				}
				return comparison
			}
		}
		return cmp.Compare(left.id, right.id)
	})
	ids := make([]string, len(kept))
	for at, item := range kept {
		ids[at] = item.id
	}
	return ids
}

func sortFieldsOf(orders []pantryOrder) []engine.SortField {
	fields := make([]engine.SortField, len(orders))
	for at, order := range orders {
		fields[at] = engine.SortField{Field: order.field, Direction: engine.SortAscending}
		if order.desc {
			fields[at].Direction = engine.SortDescending
		}
		if order.mean {
			fields[at].Mode = engine.SortByMean
		}
	}
	return fields
}

func stockPantry(t *testing.T, narsil *engine.Narsil) map[string]pantryItem {
	t.Helper()
	ctx := context.Background()
	items := map[string]pantryItem{}
	batch := make([]*engine.Document, 0, pantryFrozenItems)
	for at := range pantryFrozenItems {
		item := pantryItemOf(at)
		items[item.id] = item
		batch = append(batch, item.document())
	}
	insertEvery(t, narsil, pantryIndexName, batch)
	if err := narsil.Checkpoint(ctx, pantryIndexName); err != nil {
		t.Fatalf("the checkpoint that freezes the first items failed: %v", err)
	}
	for at := range pantryFrozenItems {
		item := pantryItemOf(at)
		switch {
		case at%pantryRemovalStride == 0:
			if err := narsil.Remove(ctx, pantryIndexName, item.id, engine.WriteOptions{}); err != nil {
				t.Fatalf("remove %s: %v", item.id, err)
			}
			delete(items, item.id)
		case at%pantryRepriceStride == 0:
			item.price, item.priced = float64((at*pantryPriceStep+pantryRepriceShift)%pantryPriceSpread), true
			items[item.id] = item
			if err := narsil.Update(ctx, pantryIndexName, item.id, item.document(), engine.WriteOptions{}); err != nil {
				t.Fatalf("update %s: %v", item.id, err)
			}
		}
	}
	batch = batch[:0]
	for at := pantryFrozenItems; at < pantryFrozenItems+pantryGrowingItems; at++ {
		item := pantryItemOf(at)
		items[item.id] = item
		batch = append(batch, item.document())
	}
	insertEvery(t, narsil, pantryIndexName, batch)
	return items
}

func pagedQuery(t *testing.T, narsil *engine.Narsil, params engine.QueryParams) ([]string, engine.QueryResult) {
	t.Helper()
	var ids []string
	var first engine.QueryResult
	for page := 0; ; page++ {
		result, err := narsil.Query(context.Background(), pantryIndexName, params)
		if err != nil {
			t.Fatalf("page %d of the sorted search failed: %v", page, err)
		}
		if page == 0 {
			first = result
		}
		limit, _ := params.Limit.Get()
		if len(result.Hits) > limit {
			t.Fatalf("page %d of the sorted search holds %d hits over its limit of %d", page, len(result.Hits), limit)
		}
		for _, hit := range result.Hits {
			ids = append(ids, hit.ID)
		}
		if result.Cursor == "" {
			return ids, first
		}
		params.SearchAfter = engine.Some(result.Cursor)
	}
}

func pagedList(t *testing.T, narsil *engine.Narsil, params engine.ListParams) ([]string, int) {
	t.Helper()
	var ids []string
	total := -1
	for page := 0; ; page++ {
		result, err := narsil.ListDocuments(context.Background(), pantryIndexName, params)
		if err != nil {
			t.Fatalf("page %d of the sorted list failed: %v", page, err)
		}
		if total >= 0 && result.Total != total {
			t.Fatalf("page %d of the sorted list counts %d, while the first page counted %d", page, result.Total, total)
		}
		total = result.Total
		for _, listed := range result.Documents {
			ids = append(ids, listed.ID)
		}
		if result.Cursor == "" {
			return ids, total
		}
		params.Cursor = engine.Some(result.Cursor)
	}
}

func requirePantryQueries(t *testing.T, narsil *engine.Narsil, items map[string]pantryItem, when string) {
	t.Helper()
	orders := []pantryOrder{{field: "price", desc: true}, {field: "sizes", mean: true}}
	marked := func(item pantryItem) bool { return item.marked }
	want := expectedPantryOrder(items, marked, orders)
	wantKinds := map[string]int{}
	for _, item := range items {
		if item.marked {
			wantKinds[item.kind]++
		}
	}
	base := engine.QueryParams{Term: pantryMarker, Fields: []string{"title"}, Sort: sortFieldsOf(orders), Limit: engine.Some(pantryPage)}
	for _, scored := range []bool{false, true} {
		params := base
		params.IncludeScores = scored
		params.Facets = engine.FacetConfig{"kind": {}}
		got, first := pagedQuery(t, narsil, params)
		if !slices.Equal(got, want) {
			t.Fatalf("the sorted search %s with scores %v pages through %q, want %q", when, scored, got, want)
		}
		if first.Count != len(want) {
			t.Fatalf("the sorted search %s with scores %v counts %d, want %d", when, scored, first.Count, len(want))
		}
		gotKinds := map[string]int{}
		for _, value := range first.Facets["kind"].Values {
			gotKinds[value.Value] = value.Count
		}
		for _, kind := range pantryKinds {
			if gotKinds[kind] != wantKinds[kind] {
				t.Fatalf("the facet of the sorted search %s with scores %v counts %v, want %v", when, scored, gotKinds, wantKinds)
			}
		}
		params.Offset = pantryOffset
		params.Facets = nil
		offset, err := narsil.Query(context.Background(), pantryIndexName, params)
		if err != nil {
			t.Fatalf("the sorted search %s with an offset failed: %v", when, err)
		}
		wantOffset := want[min(pantryOffset, len(want)):min(pantryOffset+pantryPage, len(want))]
		gotOffset := make([]string, len(offset.Hits))
		for at, hit := range offset.Hits {
			gotOffset[at] = hit.ID
		}
		if !slices.Equal(gotOffset, wantOffset) {
			t.Fatalf("the sorted search %s with scores %v and an offset returns %q, want %q", when, scored, gotOffset, wantOffset)
		}
	}
}

func requirePantryLists(t *testing.T, narsil *engine.Narsil, items map[string]pantryItem, when string) {
	t.Helper()
	cheapest := []pantryOrder{{field: "price"}}
	pricedAbove := func(item pantryItem) bool { return item.priced && item.price >= pantryListFloor }
	filter := &engine.FilterExpression{Fields: map[string]engine.FieldFilter{"price": {Gte: engine.NumberBound(pantryListFloor)}}}
	got, total := pagedList(t, narsil, engine.ListParams{Sort: sortFieldsOf(cheapest), Filters: filter, Limit: engine.Some(pantryPage)})
	if want := expectedPantryOrder(items, pricedAbove, cheapest); !slices.Equal(got, want) || total != len(want) {
		t.Fatalf("the filtered sorted list %s pages through %q with a total of %d, want %q", when, got, total, want)
	}
	largest := []pantryOrder{{field: "sizes", desc: true}, {field: "price"}}
	got, total = pagedList(t, narsil, engine.ListParams{Sort: sortFieldsOf(largest), Limit: engine.Some(pantryPage)})
	if want := expectedPantryOrder(items, func(pantryItem) bool { return true }, largest); !slices.Equal(got, want) || total != len(want) {
		t.Fatalf("the sorted list %s pages through %q with a total of %d, want %q", when, got, total, want)
	}
}

func TestSortedSearchesAndListsFollowTheSortKeysAcrossFrozenAndGrowingSegments(t *testing.T) {
	t.Run("one partition whose checkpoint freezes its segment", func(t *testing.T) { requirePantrySorts(t, 1) })
	t.Run("several partitions", func(t *testing.T) { requirePantrySorts(t, pantryPartitions) })
}

func requirePantrySorts(t *testing.T, partitions int) {
	ctx := context.Background()
	narsil := openPlainEngine(t, engine.Config{Durability: &engine.DurabilityConfig{Directory: t.TempDir(), Mode: engine.DurabilitySync}})
	createSpreadIndex(t, narsil, pantryIndexName, engine.Schema{"title": engine.FieldString, "price": engine.FieldNumber,
		"sizes": engine.FieldNumberList, "kind": engine.FieldEnum}, partitions)
	items := stockPantry(t, narsil)
	for _, round := range []string{"on the first read", "on a repeated read"} {
		requirePantryQueries(t, narsil, items, round)
		requirePantryLists(t, narsil, items, round)
	}

	raised := items[pantryWideID]
	raised.price, raised.priced = pantryRaisedPrice, true
	items[raised.id] = raised
	if err := narsil.Update(ctx, pantryIndexName, raised.id, raised.document(), engine.WriteOptions{}); err != nil {
		t.Fatalf("raising the price of %s failed: %v", raised.id, err)
	}
	requirePantryQueries(t, narsil, items, "after a write")
	requirePantryLists(t, narsil, items, "after a write")

	whole, err := narsil.Query(ctx, pantryIndexName, engine.QueryParams{Term: pantryMarker, Fields: []string{"title"},
		Sort: sortFieldsOf([]pantryOrder{{field: "price"}}), Limit: engine.Some(pantryWholeLimit),
		Pinned: []engine.PinnedDocument{{DocID: raised.id, Position: 0}}})
	if err != nil {
		t.Fatalf("the sorted search with a pinned document failed: %v", err)
	}
	cheapestMarked := expectedPantryOrder(items, func(item pantryItem) bool { return item.marked && item.id != raised.id }, []pantryOrder{{field: "price"}})
	want := append([]string{raised.id}, cheapestMarked...)
	got := make([]string, len(whole.Hits))
	for at, hit := range whole.Hits {
		got[at] = hit.ID
	}
	if !slices.Equal(got, want) {
		t.Fatalf("the sorted search with a pinned document returns %q, want %q", got, want)
	}
}

func TestAPreflightCountsTheMatchesAndStopsUnderACancelledContext(t *testing.T) {
	narsil := openPlainEngine(t, engine.Config{})
	createSpreadIndex(t, narsil, pantryIndexName, engine.Schema{"title": engine.FieldString, "price": engine.FieldNumber,
		"sizes": engine.FieldNumberList, "kind": engine.FieldEnum}, pantryPartitions)
	batch := make([]*engine.Document, 0, pantryGrowingItems)
	marked := 0
	for at := range pantryGrowingItems {
		item := pantryItemOf(at)
		if item.marked {
			marked++
		}
		batch = append(batch, item.document())
	}
	insertEvery(t, narsil, pantryIndexName, batch)
	params := engine.QueryParams{Term: pantryMarker, Fields: []string{"title"}}
	counted, err := narsil.Preflight(context.Background(), pantryIndexName, params)
	if err != nil || counted.Count != marked {
		t.Fatalf("the preflight counts %d with error %v, want %d", counted.Count, err, marked)
	}
	stopped, stop := context.WithCancel(context.Background())
	stop()
	if _, err := narsil.Preflight(stopped, pantryIndexName, params); !errors.Is(err, context.Canceled) {
		t.Fatalf("the preflight under a cancelled context returned %v, want the context's cancellation error", err)
	}
}
