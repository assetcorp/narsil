package engine_test

import (
	"context"
	"maps"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	mergedNotesIndex            = "notes"
	mergedNotesMarker           = "ledger"
	mergedNotesDocuments        = 3_000
	mergedNotesMaxDocuments     = 30_000
	mergedNotesBatch            = 500
	mergedNotesRepeats          = 2_000
	mergedNotesWorkCap          = 1 << 40
	mergedNotesMinimumSegments  = 3
	mergedNotesThinnedBelow     = 2_400
	mergedNotesKeptEvery        = 10
	mergedNotesDeadline         = 30 * time.Second
	mergedNotesPollInterval     = 50 * time.Millisecond
	mergedNotesKeptGrowingEvery = 250 * time.Millisecond
)

type mergedNotesFilter struct {
	name   string
	filter engine.FieldFilter
	holds  func(note string) bool
}

var mergedNotesFilters = []mergedNotesFilter{
	{"a regex", engine.FieldFilter{Regex: engine.Some("(ab)*[0-9]*[13579]")},
		regexp.MustCompile("(ab)*[0-9]*[13579]").MatchString},
	{"a substring", engine.FieldFilter{Contains: engine.Some("b1")},
		func(note string) bool { return strings.Contains(note, "b1") }},
	{"a suffix", engine.FieldFilter{EndsWith: engine.Some("7")},
		func(note string) bool { return strings.HasSuffix(note, "7") }},
}

func TestAMergeKeepsEveryPatternMatchOfTheSegmentsThatItJoins(t *testing.T) {
	cases := []struct {
		name              string
		searchBeforeMerge bool
		thinOlderSegments bool
	}{
		{"the tail frozen after a search joins first", true, false},
		{"the segments frozen before a search join first", true, true},
		{"no segment froze after a search", false, false},
	}
	for _, scenario := range cases {
		t.Run(scenario.name, func(t *testing.T) {
			t.Parallel()
			checkMergedPatternMatches(t, scenario.searchBeforeMerge, scenario.thinOlderSegments)
		})
	}
}

func checkMergedPatternMatches(t *testing.T, searchBeforeMerge, thinOlderSegments bool) {
	ctx := context.Background()
	narsil := openPlainEngine(t, engine.Config{PatternWorkCap: engine.Some(int64(mergedNotesWorkCap))})
	createSpreadIndex(t, narsil, mergedNotesIndex, engine.Schema{"title": engine.FieldString,
		"note": engine.FieldString.WithOptions(engine.TextFieldPattern)}, 1)
	prefix := strings.Repeat("ab", mergedNotesRepeats)
	notes := insertNotesUntilTheyFillSegments(t, narsil, prefix)
	stopWriting := keepTheNotesGrowing(narsil, prefix, len(notes))
	if thinOlderSegments {
		var removed []string
		for at := range mergedNotesThinnedBelow {
			if at%mergedNotesKeptEvery != 0 {
				removed = append(removed, "note-"+strconv.Itoa(at))
			}
		}
		result, err := narsil.RemoveBatch(ctx, mergedNotesIndex, removed, engine.WriteOptions{})
		if err != nil || len(result.Failed) != 0 {
			t.Fatalf("removing %d notes failed: %v, with %d refused", len(removed), err, len(result.Failed))
		}
		for _, id := range removed {
			delete(notes, id)
		}
	}
	segments, err := engine.SearchedSegmentsOf(ctx, narsil, mergedNotesIndex)
	added, writeErr := stopWriting()
	if writeErr != nil {
		t.Fatalf("a note written to keep the index from going quiet failed: %v", writeErr)
	}
	maps.Copy(notes, added)
	if err != nil || len(segments) != 1 || segments[0] < mergedNotesMinimumSegments {
		t.Fatalf("before the merge a search reads %v segments with error %v, while the case needs at least %d",
			segments, err, mergedNotesMinimumSegments)
	}
	if searchBeforeMerge {
		requireMergedPatternMatches(t, narsil, notes, "before the merge")
	}
	deadline := time.Now().Add(mergedNotesDeadline)
	for {
		segments, err := engine.SearchedSegmentsOf(ctx, narsil, mergedNotesIndex)
		if err != nil {
			t.Fatalf("reading the searched segments failed: %v", err)
		}
		if len(segments) == 1 && segments[0] == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("%v after the last write, a search still reads %v segments", mergedNotesDeadline, segments)
		}
		time.Sleep(mergedNotesPollInterval)
	}
	requireMergedPatternMatches(t, narsil, notes, "after the merge")
}

func insertNotesUntilTheyFillSegments(t *testing.T, narsil *engine.Narsil, prefix string) map[string]string {
	t.Helper()
	notes := map[string]string{}
	for first := 0; first < mergedNotesMaxDocuments; first += mergedNotesBatch {
		batch := make([]*engine.Document, 0, mergedNotesBatch)
		for number := first; number < first+mergedNotesBatch; number++ {
			batch = append(batch, engine.DocumentFromMap(map[string]any{"id": "note-" + strconv.Itoa(number),
				"title": mergedNotesMarker, "note": prefix + strconv.Itoa(number)}))
		}
		insertEvery(t, narsil, mergedNotesIndex, batch)
		for number := first; number < first+mergedNotesBatch; number++ {
			notes["note-"+strconv.Itoa(number)] = prefix + strconv.Itoa(number)
		}
		segments, err := engine.SearchedSegmentsOf(context.Background(), narsil, mergedNotesIndex)
		if err != nil || len(segments) != 1 {
			t.Fatalf("reading the searched segments failed: %v, with %v", err, segments)
		}
		if len(notes) >= mergedNotesDocuments && segments[0] >= mergedNotesMinimumSegments {
			return notes
		}
	}
	t.Fatalf("%d notes never filled %d segments", len(notes), mergedNotesMinimumSegments)
	return nil
}

func keepTheNotesGrowing(narsil *engine.Narsil, prefix string, first int) func() (map[string]string, error) {
	stop, done := make(chan struct{}), make(chan struct{})
	added := map[string]string{}
	var failure error
	go func() {
		defer close(done)
		ticker := time.NewTicker(mergedNotesKeptGrowingEvery)
		defer ticker.Stop()
		for number := first; ; number++ {
			select {
			case <-stop:
				return
			case <-ticker.C:
			}
			id, note := "note-"+strconv.Itoa(number), prefix+strconv.Itoa(number)
			document := engine.DocumentFromMap(map[string]any{"title": mergedNotesMarker, "note": note})
			if _, err := narsil.Insert(context.Background(), mergedNotesIndex, document, id, engine.InsertOptions{}); err != nil {
				failure = err
				return
			}
			added[id] = note
		}
	}()
	return func() (map[string]string, error) {
		close(stop)
		<-done
		return added, failure
	}
}

func requireMergedPatternMatches(t *testing.T, narsil *engine.Narsil, notes map[string]string, stage string) {
	t.Helper()
	for _, test := range mergedNotesFilters {
		var want []string
		for id, note := range notes {
			if test.holds(note) {
				want = append(want, id)
			}
		}
		slices.Sort(want)
		result, err := narsil.Query(context.Background(), mergedNotesIndex, engine.QueryParams{Term: mergedNotesMarker,
			Fields: []string{"title"}, Limit: engine.Some(len(notes)),
			Filters: &engine.FilterExpression{Fields: map[string]engine.FieldFilter{"note": test.filter}}})
		if err != nil {
			t.Fatalf("%s, the search with %s failed: %v", stage, test.name, err)
		}
		got := make([]string, 0, len(result.Hits))
		for _, hit := range result.Hits {
			got = append(got, hit.ID)
		}
		slices.Sort(got)
		if result.Count != len(want) || !slices.Equal(got, want) {
			t.Fatalf("%s, the search with %s counts %d and returns %d notes, while %d of the %d live notes match",
				stage, test.name, result.Count, len(got), len(want), len(notes))
		}
	}
}
