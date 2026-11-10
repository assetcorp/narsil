package engine_test

import (
	"context"
	"fmt"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	tallyIndex           = "tallys"
	tallySearchers       = 8
	tallyGroups          = 5
	tallyHitCeiling      = 10_000
	tallyQuietDocuments  = 9_000
	tallyQuietBatch      = 1_500
	tallyRounds          = 6
	tallyRoundInserts    = 1_200
	tallyRoundUpdates    = 160
	tallyRoundRemovals   = 400
	tallyQuietRound      = 3
	tallyCheckpointRound = 4
	tallyRemovedGroup    = -1
)

var tallyGroupWords = []string{"heron", "lynx", "otter", "badger", "kestrel"}

type tallyEvent struct {
	id    string
	group int
}

type tallyHistory struct {
	mu       sync.Mutex
	events   []tallyEvent
	finished atomic.Int64
	live     map[string]int
	serial   int
}

func (h *tallyHistory) plan(events []tallyEvent) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.events = append(h.events, events...)
}

func (h *tallyHistory) commit() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.finished.Store(int64(len(h.events)))
}

func (h *tallyHistory) planned() []tallyEvent {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.events[:len(h.events):len(h.events)]
}

func tallyDocument(id string, group int, serial int) *engine.Document {
	return engine.NewDocument().Set("id", id).
		Set("title", tallyGroupWords[group]+" tally entry "+strconv.Itoa(serial)).
		Set("tag", tallyGroupWords[group]).Set("serial", float64(serial))
}

func answerMatchesSomeState(events []tallyEvent, from int, group int, found map[string]bool) bool {
	current := map[string]int{}
	for _, event := range events[:from] {
		current[event.id] = event.group
	}
	missing := 0
	for id, held := range current {
		if held == group && !found[id] {
			missing++
		}
	}
	extra := 0
	for id := range found {
		if held, present := current[id]; !present || held != group {
			extra++
		}
	}
	if missing+extra == 0 {
		return true
	}
	for _, event := range events[from:] {
		previous, present := current[event.id]
		wasMember := present && previous == group
		isMember := event.group == group
		current[event.id] = event.group
		switch {
		case wasMember && !isMember && found[event.id]:
			extra++
		case wasMember && !isMember:
			missing--
		case !wasMember && isMember && found[event.id]:
			extra--
		case !wasMember && isMember:
			missing++
		}
		if missing+extra == 0 {
			return true
		}
	}
	return false
}

func groupFilter(group int) *engine.FilterExpression {
	return &engine.FilterExpression{Fields: map[string]engine.FieldFilter{"tag": {Eq: engine.TextValue(tallyGroupWords[group])}}}
}

func tallyHits(group int, byFilter bool, narsil *engine.Narsil, ctx context.Context) ([]engine.ListedDocument, int, error) {
	shown := engine.IncludeFields("title", "tag")
	if byFilter {
		listed, err := narsil.ListDocuments(ctx, tallyIndex, engine.ListParams{Filters: groupFilter(group),
			Limit: engine.Some(tallyHitCeiling), Document: shown})
		return listed.Documents, listed.Total, err
	}
	result, err := narsil.Query(ctx, tallyIndex, engine.QueryParams{Term: tallyGroupWords[group], Fields: []string{"title"},
		Limit: engine.Some(tallyHitCeiling), Document: shown})
	hits := make([]engine.ListedDocument, len(result.Hits))
	for at, hit := range result.Hits {
		hits[at] = engine.ListedDocument{ID: hit.ID, Document: hit.Document}
	}
	return hits, result.Count, err
}

func tallyAnswer(ctx context.Context, narsil *engine.Narsil, group int, byFilter bool) (map[string]bool, error) {
	word := tallyGroupWords[group]
	hits, total, err := tallyHits(group, byFilter, narsil, ctx)
	if err != nil {
		return nil, fmt.Errorf("the search for %s failed: %w", word, err)
	}
	found := make(map[string]bool, len(hits))
	for _, hit := range hits {
		if found[hit.ID] {
			return nil, fmt.Errorf("the search for %s returned %s twice", word, hit.ID)
		}
		found[hit.ID] = true
		tag, _ := hit.Document.Get("tag")
		title, _ := hit.Document.Get("title")
		titleText, _ := title.(string)
		if tag != word || len(titleText) < len(word) || titleText[:len(word)] != word {
			return nil, fmt.Errorf("the search for %s returned %s holding the tag %v and the title %q", word, hit.ID, tag, titleText)
		}
	}
	if total != len(found) {
		return nil, fmt.Errorf("the search for %s counts %d hits and returns %d", word, total, len(found))
	}
	return found, nil
}

func searchTallyOnce(ctx context.Context, narsil *engine.Narsil, history *tallyHistory, round int) error {
	group := round % tallyGroups
	from := int(history.finished.Load())
	found, err := tallyAnswer(ctx, narsil, group, round%2 == 1)
	if err != nil {
		return err
	}
	events := history.planned()
	if !answerMatchesSomeState(events, from, group, found) {
		return fmt.Errorf("the search for %s returned %d documents that match no state between event %d and event %d",
			tallyGroupWords[group], len(found), from, len(events))
	}
	return nil
}

func requireTallyExact(t *testing.T, narsil *engine.Narsil, history *tallyHistory, moment string) {
	t.Helper()
	ctx := context.Background()
	for group := range tallyGroups {
		for _, byFilter := range []bool{false, true} {
			found, err := tallyAnswer(ctx, narsil, group, byFilter)
			if err != nil {
				t.Fatalf("%s, %v", moment, err)
			}
			events := history.planned()
			if !answerMatchesSomeState(events, len(events), group, found) {
				t.Fatalf("%s, the search for %s returned %d documents that differ from the oracle", moment,
					tallyGroupWords[group], len(found))
			}
		}
	}
	count, err := narsil.CountDocuments(ctx, tallyIndex)
	if err != nil || count != len(history.live) {
		t.Fatalf("%s, the index counts %d documents (%v) where the oracle holds %d", moment, count, err, len(history.live))
	}
}

func refusedIDs(result engine.BatchResult) map[string]int {
	refused := map[string]int{}
	for _, failure := range result.Failed {
		refused[failure.DocID]++
	}
	return refused
}

func requireRefusals(t *testing.T, operation string, result engine.BatchResult, err error, want map[string]int) {
	t.Helper()
	if err != nil {
		t.Fatalf("the %s batch failed with %s: %v", operation, codeOrMessage(err), err)
	}
	got := refusedIDs(result)
	if len(got) != len(want) {
		t.Fatalf("the %s batch refused %v where the oracle refuses %v", operation, got, want)
	}
	for id, times := range want {
		if got[id] != times {
			t.Fatalf("the %s batch refused %v where the oracle refuses %v", operation, got, want)
		}
	}
}

func (h *tallyHistory) liveIDs(count int, skip int) []string {
	ids := make([]string, 0, count)
	for serial := 0; serial < h.serial && len(ids) < count; serial++ {
		id := "led-" + strconv.Itoa(serial)
		if _, live := h.live[id]; live && serial%3 == skip%3 {
			ids = append(ids, id)
		}
	}
	return ids
}

func insertTally(t *testing.T, narsil *engine.Narsil, history *tallyHistory, count int) {
	t.Helper()
	documents := make([]*engine.Document, 0, count+3)
	events := make([]tallyEvent, 0, count)
	want := map[string]int{}
	for range count {
		id := "led-" + strconv.Itoa(history.serial)
		group := history.serial * 7 % tallyGroups
		documents = append(documents, tallyDocument(id, group, history.serial))
		events = append(events, tallyEvent{id: id, group: group})
		history.serial++
	}
	repeated := events[len(events)-1]
	documents = append(documents, tallyDocument(repeated.id, (repeated.group+1)%tallyGroups, history.serial))
	want[repeated.id] = 1
	for _, held := range history.liveIDs(2, history.serial) {
		documents = append(documents, tallyDocument(held, 0, history.serial))
		want[held] = 1
	}
	history.plan(events)
	result, err := narsil.InsertBatch(context.Background(), tallyIndex, documents, engine.InsertOptions{})
	for _, event := range events {
		history.live[event.id] = event.group
	}
	history.commit()
	requireRefusals(t, "insert", result, err, want)
}

func updateTally(t *testing.T, narsil *engine.Narsil, history *tallyHistory, round int) {
	t.Helper()
	ids := history.liveIDs(tallyRoundUpdates, round)
	updates := make([]engine.DocumentUpdate, 0, len(ids)+1)
	events := make([]tallyEvent, 0, len(ids))
	for _, id := range ids {
		group := (history.live[id] + 1 + round) % tallyGroups
		updates = append(updates, engine.DocumentUpdate{DocID: id, Document: tallyDocument(id, group, history.serial)})
		events = append(events, tallyEvent{id: id, group: group})
	}
	missing := "led-missing-" + strconv.Itoa(round)
	updates = append(updates, engine.DocumentUpdate{DocID: missing, Document: tallyDocument(missing, 0, 0)})
	history.plan(events)
	result, err := narsil.UpdateBatch(context.Background(), tallyIndex, updates, engine.WriteOptions{})
	for _, event := range events {
		history.live[event.id] = event.group
	}
	history.commit()
	requireRefusals(t, "update", result, err, map[string]int{missing: 1})
}

func removeTally(t *testing.T, narsil *engine.Narsil, history *tallyHistory, round int) {
	t.Helper()
	ids := history.liveIDs(tallyRoundRemovals, round+1)
	events := make([]tallyEvent, 0, len(ids))
	for _, id := range ids {
		events = append(events, tallyEvent{id: id, group: tallyRemovedGroup})
	}
	missing := "led-gone-" + strconv.Itoa(round)
	history.plan(events)
	result, err := narsil.RemoveBatch(context.Background(), tallyIndex, append(ids, missing), engine.WriteOptions{})
	for _, id := range ids {
		delete(history.live, id)
	}
	history.commit()
	requireRefusals(t, "remove", result, err, map[string]int{missing: 1})
}

func startTallySearchers(narsil *engine.Narsil, history *tallyHistory, quiet *sync.RWMutex,
	failures chan<- error) (stop func(), searches *atomic.Int64) {
	stopped := atomic.Bool{}
	searches = &atomic.Int64{}
	group := sync.WaitGroup{}
	for searcher := range tallySearchers {
		group.Go(func() {
			for round := searcher; !stopped.Load(); round++ {
				quiet.RLock()
				err := searchTallyOnce(context.Background(), narsil, history, round)
				quiet.RUnlock()
				searches.Add(1)
				if err != nil {
					failures <- err
					return
				}
			}
		})
	}
	return func() { stopped.Store(true); group.Wait() }, searches
}

func openTallyEngine(t *testing.T, directory string) *engine.Narsil {
	t.Helper()
	narsil, err := engine.New(context.Background(), engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)},
		Durability: &engine.DurabilityConfig{Directory: directory, Mode: engine.DurabilitySync}})
	if err != nil {
		t.Fatalf("the engine refused to start with %s: %v", codeOrMessage(err), err)
	}
	return narsil
}

func TestSearchesDuringLargeWriteBatchesMatchTheCommittedTally(t *testing.T) {
	directory := t.TempDir()
	narsil := openTallyEngine(t, directory)
	ctx := context.Background()
	if err := narsil.CreateIndex(ctx, tallyIndex, engine.IndexConfig{Schema: engine.Schema{"title": engine.FieldString,
		"tag": engine.FieldEnum, "serial": engine.FieldNumber}, Language: "english"}); err != nil {
		t.Fatalf("the engine refused the index with %s: %v", codeOrMessage(err), err)
	}
	history := &tallyHistory{live: map[string]int{}}
	for range tallyQuietDocuments / tallyQuietBatch {
		insertTally(t, narsil, history, tallyQuietBatch)
	}
	if err := narsil.Checkpoint(ctx, tallyIndex); err != nil {
		t.Fatalf("the first checkpoint failed with %s: %v", codeOrMessage(err), err)
	}
	quiet := &sync.RWMutex{}
	failures := make(chan error, tallySearchers)
	stop, searches := startTallySearchers(narsil, history, quiet, failures)
	for round := range tallyRounds {
		if round == tallyQuietRound {
			quiet.Lock()
			insertTally(t, narsil, history, tallyQuietDocuments)
			quiet.Unlock()
		}
		insertTally(t, narsil, history, tallyRoundInserts)
		updateTally(t, narsil, history, round)
		removeTally(t, narsil, history, round)
		if round == tallyCheckpointRound {
			if err := narsil.Checkpoint(ctx, tallyIndex); err != nil {
				t.Fatalf("the checkpoint under searches failed with %s: %v", codeOrMessage(err), err)
			}
		}
	}
	stop()
	close(failures)
	for err := range failures {
		t.Fatal(err)
	}
	if searches.Load() < tallySearchers {
		t.Fatalf("the searchers finished %d searches, fewer than one each", searches.Load())
	}
	requireTallyExact(t, narsil, history, "after the writes")
	if err := narsil.Shutdown(ctx); err != nil {
		t.Fatalf("the engine refused to shut down with %s: %v", codeOrMessage(err), err)
	}
	reopened := openTallyEngine(t, directory)
	defer func() { _ = reopened.Shutdown(context.Background()) }()
	requireTallyExact(t, reopened, history, "after the restart")
}
