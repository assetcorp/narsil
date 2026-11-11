package engine_test

import (
	"cmp"
	"context"
	"errors"
	"math"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	wardrobeIndexName      = "wardrobe"
	wardrobePartitions     = 3
	wardrobeGarments       = 96
	wardrobeMarker         = "garment"
	wardrobeListPage       = 25
	wardrobeRemovalStride  = 7
	wardrobeUpdateStride   = 5
	wardrobeColourSets     = 16
	galleyIndexName        = "galley"
	galleyPartitions       = 3
	galleyMarker           = "kettle"
	galleyMatching         = 40
	galleyOthers           = 20
	galleyLongestTitle     = 5
	galleyKeptLength       = 2
	galleyScoreTolerance   = 1e-6
	galleyHitLimit         = 500
	galleyWidePinNearer    = 1<<32 + 5
	galleyWidePinFurther   = 1<<33 + 1
	archiveIndexName       = "archive"
	archiveMarker          = "ledger"
	archiveOddDigits       = "13579"
	archiveTimedRounds     = 3
	archiveDocuments       = 3_000
	archiveNoteRepeats     = 2_000
	archiveDeadlineDivisor = 8
	archiveWorkCap         = 1 << 40
)

var (
	wardrobeColours = []string{"red", "blue", "green", "amber"}
	galleyFillers   = []string{"harbour", "lantern", "compass", "anchor"}
	galleyKinds     = []string{"copper", "steel", "clay"}
)

func openPlainEngine(t *testing.T, config engine.Config) *engine.Narsil {
	t.Helper()
	config.Workers = engine.WorkerConfig{Enabled: engine.Some(false)}
	narsil, err := engine.New(context.Background(), config)
	if err != nil {
		t.Fatalf("the engine refused to start: %v", err)
	}
	t.Cleanup(func() { _ = narsil.Shutdown(context.Background()) })
	return narsil
}

func createSpreadIndex(t *testing.T, narsil *engine.Narsil, name string, schema engine.Schema, partitions int) {
	t.Helper()
	ctx := context.Background()
	config := engine.IndexConfig{Schema: schema, DefaultScoring: engine.ScoringDFS,
		Partitions: engine.PartitionConfig{MaxPartitions: engine.Some(partitions)}}
	if err := narsil.CreateIndex(ctx, name, config); err != nil {
		t.Fatalf("the engine refused the index: %v", err)
	}
	if partitions > 1 {
		if err := narsil.Rebalance(ctx, name, partitions); err != nil {
			t.Fatalf("spreading the index over %d partitions failed: %v", partitions, err)
		}
	}
}

func insertEvery(t *testing.T, narsil *engine.Narsil, name string, documents []*engine.Document) {
	t.Helper()
	result, err := narsil.InsertBatch(context.Background(), name, documents, engine.InsertOptions{})
	if err != nil || len(result.Failed) != 0 {
		t.Fatalf("the batch insert failed: %v, with %d refused documents", err, len(result.Failed))
	}
}

func coloursOf(set int) []string {
	var colours []string
	for bit, colour := range wardrobeColours {
		if set&(1<<bit) != 0 {
			colours = append(colours, colour)
		}
	}
	return colours
}

func garmentOf(id string, colours []string) *engine.Document {
	record := map[string]any{"id": id, "title": wardrobeMarker + " " + id}
	if len(colours) > 0 {
		tags := make([]any, len(colours))
		for at, colour := range colours {
			tags[at] = colour
		}
		record["tags"] = tags
	}
	return engine.DocumentFromMap(record)
}

func stockWardrobe(t *testing.T, narsil *engine.Narsil) map[string][]string {
	t.Helper()
	ctx := context.Background()
	held := map[string][]string{}
	documents := make([]*engine.Document, 0, wardrobeGarments)
	for at := range wardrobeGarments {
		id := "garment-" + strconv.Itoa(at)
		held[id] = coloursOf((at*7 + 3) % wardrobeColourSets)
		documents = append(documents, garmentOf(id, held[id]))
	}
	insertEvery(t, narsil, wardrobeIndexName, documents)
	for at := range wardrobeGarments {
		id := "garment-" + strconv.Itoa(at)
		switch {
		case at%wardrobeRemovalStride == 0:
			if err := narsil.Remove(ctx, wardrobeIndexName, id, engine.WriteOptions{}); err != nil {
				t.Fatalf("remove %s: %v", id, err)
			}
			delete(held, id)
		case at%wardrobeUpdateStride == 0:
			held[id] = coloursOf((at*3 + 1) % wardrobeColourSets)
			if err := narsil.Update(ctx, wardrobeIndexName, id, garmentOf(id, held[id]), engine.WriteOptions{}); err != nil {
				t.Fatalf("update %s: %v", id, err)
			}
		}
	}
	return held
}

func idsWhere(held map[string][]string, keep func(colours []string) bool) []string {
	var ids []string
	for id, colours := range held {
		if len(colours) > 0 && keep(colours) {
			ids = append(ids, id)
		}
	}
	slices.Sort(ids)
	return ids
}

func listedIDs(t *testing.T, narsil *engine.Narsil, filter *engine.FilterExpression) []string {
	t.Helper()
	var ids []string
	params := engine.ListParams{Filters: filter, Limit: engine.Some(wardrobeListPage)}
	for {
		page, err := narsil.ListDocuments(context.Background(), wardrobeIndexName, params)
		if err != nil {
			t.Fatalf("the filtered list failed: %v", err)
		}
		for _, listed := range page.Documents {
			ids = append(ids, listed.ID)
		}
		if page.Cursor == "" || len(page.Documents) == 0 {
			slices.Sort(ids)
			return ids
		}
		params.Cursor = engine.Some(page.Cursor)
	}
}

func searchedIDs(t *testing.T, narsil *engine.Narsil, filter *engine.FilterExpression) ([]string, int) {
	t.Helper()
	result, err := narsil.Query(context.Background(), wardrobeIndexName, engine.QueryParams{
		Term: wardrobeMarker, Fields: []string{"title"}, Filters: filter, Limit: engine.Some(wardrobeGarments)})
	if err != nil {
		t.Fatalf("the filtered search failed: %v", err)
	}
	ids := make([]string, len(result.Hits))
	for at, hit := range result.Hits {
		ids[at] = hit.ID
	}
	slices.Sort(ids)
	return ids, result.Count
}

func TestPatternFieldExclusionsAndElementTestsFollowTheStoredValues(t *testing.T) {
	narsil := openPlainEngine(t, engine.Config{})
	createSpreadIndex(t, narsil, wardrobeIndexName, engine.Schema{"title": engine.FieldString,
		"tags": engine.FieldStringList.WithOptions(engine.TextFieldPattern)}, wardrobePartitions)
	held := stockWardrobe(t, narsil)
	holdsEvery := func(wanted ...string) func([]string) bool {
		return func(colours []string) bool {
			for _, colour := range wanted {
				if !slices.Contains(colours, colour) {
					return false
				}
			}
			return true
		}
	}
	holdsNone := func(refused ...string) func([]string) bool {
		return func(colours []string) bool {
			for _, colour := range refused {
				if slices.Contains(colours, colour) {
					return false
				}
			}
			return true
		}
	}
	texts := func(values ...string) []engine.FilterValue {
		operands := make([]engine.FilterValue, len(values))
		for at, value := range values {
			operands[at] = engine.TextValue(value)
		}
		return operands
	}
	cases := []struct {
		name   string
		filter engine.FieldFilter
		want   []string
	}{
		{"ne on a held colour", engine.FieldFilter{Ne: engine.TextValue("red")}, idsWhere(held, holdsNone("red"))},
		{"ne on a colour that no garment holds", engine.FieldFilter{Ne: engine.TextValue("violet")}, idsWhere(held, holdsNone())},
		{"nin on two colours", engine.FieldFilter{Nin: []string{"red", "blue"}}, idsWhere(held, holdsNone("red", "blue"))},
		{"nin on a repeated colour", engine.FieldFilter{Nin: []string{"green", "green"}}, idsWhere(held, holdsNone("green"))},
		{"containsAll on two colours", engine.FieldFilter{ContainsAll: texts("red", "blue")}, idsWhere(held, holdsEvery("red", "blue"))},
		{"containsAll on a repeated colour", engine.FieldFilter{ContainsAll: texts("amber", "amber")}, idsWhere(held, holdsEvery("amber"))},
		{"containsAll on every colour", engine.FieldFilter{ContainsAll: texts(wardrobeColours...)}, idsWhere(held, holdsEvery(wardrobeColours...))},
		{"containsAll with a colour that no garment holds", engine.FieldFilter{ContainsAll: texts("red", "violet")}, nil},
	}
	for _, entry := range cases {
		filter := &engine.FilterExpression{Fields: map[string]engine.FieldFilter{"tags": entry.filter}}
		if got := listedIDs(t, narsil, filter); !slices.Equal(got, entry.want) {
			t.Errorf("%s lists %v, want %v", entry.name, got, entry.want)
		}
		got, count := searchedIDs(t, narsil, filter)
		if !slices.Equal(got, entry.want) || count != len(entry.want) {
			t.Errorf("%s searches to %v with a count of %d, want %v", entry.name, got, count, entry.want)
		}
	}
}

type galleyPot struct {
	id     string
	kind   string
	length int
}

func galleyTitle(length int, marked bool) string {
	words := make([]string, 0, length)
	if marked {
		words = append(words, galleyMarker)
	}
	for len(words) < length {
		words = append(words, galleyFillers[len(words)%len(galleyFillers)])
	}
	return strings.Join(words, " ")
}

func stockGalley(t *testing.T, narsil *engine.Narsil) (pots []galleyPot, documents int, tokens int) {
	t.Helper()
	batch := make([]*engine.Document, 0, galleyMatching+galleyOthers)
	for at := range galleyMatching + galleyOthers {
		marked := at < galleyMatching
		length := 1 + at%galleyLongestTitle
		id := "pot-" + strconv.Itoa(at)
		switch at {
		case 1:
			id = "ｚ-pot"
		case 6:
			id = "\U0001f600-pot"
		}
		kind := galleyKinds[at%len(galleyKinds)]
		batch = append(batch, engine.DocumentFromMap(map[string]any{"id": id, "title": galleyTitle(length, marked), "kind": kind}))
		tokens += length
		if marked {
			pots = append(pots, galleyPot{id: id, kind: kind, length: length})
		}
	}
	insertEvery(t, narsil, galleyIndexName, batch)
	return pots, len(batch), tokens
}

func galleyScore(documents, matching, length int, averageLength float64) float64 {
	return singleTokenScore(documents, matching, averageLength/float64(length))
}

func rankedPots(pots []galleyPot) []galleyPot {
	ranked := slices.Clone(pots)
	slices.SortFunc(ranked, func(left, right galleyPot) int {
		if order := cmp.Compare(left.length, right.length); order != 0 {
			return order
		}
		return cmp.Compare(left.id, right.id)
	})
	return ranked
}

func requireGalleyHits(t *testing.T, hits []engine.Hit, want []galleyPot, scoreOf func(galleyPot) float64, when string) {
	t.Helper()
	if len(hits) != len(want) {
		t.Fatalf("the search %s returned %d hits, want %d", when, len(hits), len(want))
	}
	for at, pot := range want {
		score, scored := hits[at].Score.Get()
		expected := scoreOf(pot)
		if hits[at].ID != pot.id || !scored || math.Abs(score-expected) > galleyScoreTolerance*expected {
			t.Fatalf("hit %d of the search %s is %q with score %v, want %q with score %v", at, when, hits[at].ID, score, pot.id, expected)
		}
	}
}

func TestScoreOrderMinimumScoreAndWidePinsHoldAcrossPartitions(t *testing.T) {
	ctx := context.Background()
	narsil := openPlainEngine(t, engine.Config{})
	createSpreadIndex(t, narsil, galleyIndexName, engine.Schema{"title": engine.FieldString, "kind": engine.FieldEnum}, galleyPartitions)
	pots, documents, tokens := stockGalley(t, narsil)
	average := float64(tokens) / float64(documents)
	scoreOf := func(pot galleyPot) float64 { return galleyScore(documents, len(pots), pot.length, average) }
	ranked := rankedPots(pots)

	every, err := narsil.Query(ctx, galleyIndexName, engine.QueryParams{Term: galleyMarker, Limit: engine.Some(galleyHitLimit), IncludeScores: true})
	if err != nil {
		t.Fatalf("the search without a minimum score failed: %v", err)
	}
	requireGalleyHits(t, every.Hits, ranked, scoreOf, "without a minimum score")
	if every.Count != len(ranked) {
		t.Fatalf("the search without a minimum score counts %d, want %d", every.Count, len(ranked))
	}

	var kept []galleyPot
	wantKinds := map[string]int{}
	for _, pot := range ranked {
		if pot.length <= galleyKeptLength {
			kept = append(kept, pot)
			wantKinds[pot.kind]++
		}
	}
	threshold := (galleyScore(documents, len(pots), galleyKeptLength, average) + galleyScore(documents, len(pots), galleyKeptLength+1, average)) / 2
	bounded, err := narsil.Query(ctx, galleyIndexName, engine.QueryParams{Term: galleyMarker, Limit: engine.Some(galleyHitLimit),
		IncludeScores: true, MinScore: engine.Some(threshold), Facets: engine.FacetConfig{"kind": {}}})
	if err != nil {
		t.Fatalf("the search with a minimum score failed: %v", err)
	}
	requireGalleyHits(t, bounded.Hits, kept, scoreOf, "with a minimum score")
	if bounded.Count != len(kept) {
		t.Fatalf("the search with a minimum score counts %d, want %d", bounded.Count, len(kept))
	}
	gotKinds := map[string]int{}
	for _, value := range bounded.Facets["kind"].Values {
		gotKinds[value.Value] = value.Count
	}
	for _, kind := range galleyKinds {
		if gotKinds[kind] != wantKinds[kind] {
			t.Fatalf("the facet of the search with a minimum score counts %v, want %v", gotKinds, wantKinds)
		}
	}

	raised := ranked[len(ranked)-1]
	further, nearer := "pot-"+strconv.Itoa(galleyMatching), "pot-"+strconv.Itoa(galleyMatching+1)
	pinned, err := narsil.Query(ctx, galleyIndexName, engine.QueryParams{Term: galleyMarker, Limit: engine.Some(galleyHitLimit),
		Pinned: []engine.PinnedDocument{{DocID: further, Position: galleyWidePinFurther}, {DocID: nearer, Position: galleyWidePinNearer},
			{DocID: raised.id, Position: 0}}})
	if err != nil {
		t.Fatalf("the search with pinned documents failed: %v", err)
	}
	wantOrder := []string{raised.id}
	for _, pot := range ranked[:len(ranked)-1] {
		wantOrder = append(wantOrder, pot.id)
	}
	wantOrder = append(wantOrder, nearer, further)
	gotOrder := make([]string, len(pinned.Hits))
	for at, hit := range pinned.Hits {
		gotOrder[at] = hit.ID
	}
	if !slices.Equal(gotOrder, wantOrder) {
		t.Fatalf("the search with pinned documents returns %q, want %q", gotOrder, wantOrder)
	}
}

func TestASearchStopsAtItsDeadlineWithTheContextError(t *testing.T) {
	narsil := openPlainEngine(t, engine.Config{PatternWorkCap: engine.Some(int64(archiveWorkCap))})
	createSpreadIndex(t, narsil, archiveIndexName, engine.Schema{"title": engine.FieldString,
		"note": engine.FieldString.WithOptions(engine.TextFieldPattern)}, 1)
	batch := make([]*engine.Document, archiveDocuments)
	withOddDigit := 0
	for at := range batch {
		number := strconv.Itoa(at)
		if strings.ContainsAny(number, archiveOddDigits) {
			withOddDigit++
		}
		batch[at] = engine.DocumentFromMap(map[string]any{"id": "entry-" + number, "title": archiveMarker,
			"note": strings.Repeat("ab", archiveNoteRepeats) + number})
	}
	insertEvery(t, narsil, archiveIndexName, batch)
	filter := &engine.FilterExpression{Fields: map[string]engine.FieldFilter{
		"note": {Regex: engine.Some("(ab)*[0-9]*[" + archiveOddDigits + "]")}}}
	reads := []struct {
		name string
		read func(ctx context.Context) (int, error)
	}{
		{"search", func(ctx context.Context) (int, error) {
			result, err := narsil.Query(ctx, archiveIndexName, engine.QueryParams{Term: archiveMarker, Fields: []string{"title"}, Filters: filter})
			return result.Count, err
		}},
		{"list", func(ctx context.Context) (int, error) {
			listed, err := narsil.ListDocuments(ctx, archiveIndexName, engine.ListParams{Filters: filter})
			return listed.Total, err
		}},
	}
	for _, entry := range reads {
		unbounded := time.Duration(math.MaxInt64)
		for range archiveTimedRounds {
			started := time.Now()
			count, err := entry.read(context.Background())
			if err != nil || count != withOddDigit {
				t.Fatalf("the %s without a deadline counts %d with error %v, want %d", entry.name, count, err, withOddDigit)
			}
			unbounded = min(unbounded, time.Since(started))
		}
		allowed := unbounded / archiveDeadlineDivisor
		ctx, cancel := context.WithTimeout(context.Background(), allowed)
		started := time.Now()
		_, err := entry.read(ctx)
		spent := time.Since(started)
		cancel()
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("the %s under a deadline of %v returned %v after %v, want the context's deadline error", entry.name, allowed, err, spent)
		}
		if spent >= unbounded {
			t.Fatalf("the %s under a deadline of %v took %v, as long as the %v that it takes without one", entry.name, allowed, spent, unbounded)
		}
		stopped, stop := context.WithCancel(context.Background())
		stop()
		if _, err := entry.read(stopped); !errors.Is(err, context.Canceled) {
			t.Fatalf("the %s under a cancelled context returned %v, want the context's cancellation error", entry.name, err)
		}
	}
}
