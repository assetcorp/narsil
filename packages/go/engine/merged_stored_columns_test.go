package engine_test

import (
	"context"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	mergedNotesIndex           = "notes"
	mergedNotesMarker          = "ledger"
	mergedNotesDocuments       = 3_000
	mergedNotesRepeats         = 2_000
	mergedNotesWorkCap         = 1 << 40
	mergedNotesMinimumSegments = 3
	mergedNotesThinnedBelow    = 2_400
	mergedNotesKeptEvery       = 10
	mergedNotesDeadline        = 30 * time.Second
	mergedNotesPollInterval    = 50 * time.Millisecond
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
	notes := make(map[string]string, mergedNotesDocuments)
	batch := make([]*engine.Document, mergedNotesDocuments)
	prefix := strings.Repeat("ab", mergedNotesRepeats)
	for at := range batch {
		id, note := "note-"+strconv.Itoa(at), prefix+strconv.Itoa(at)
		notes[id] = note
		batch[at] = engine.DocumentFromMap(map[string]any{"id": id, "title": mergedNotesMarker, "note": note})
	}
	insertEvery(t, narsil, mergedNotesIndex, batch)
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
