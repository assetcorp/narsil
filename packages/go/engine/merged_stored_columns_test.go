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
	mergedNotesIndex        = "notes"
	mergedNotesMarker       = "ledger"
	mergedNotesFrozenFirst  = 256
	mergedNotesWrittenAfter = 128
	mergedNotesRepeats      = 2_000
	mergedNotesWorkCap      = 1 << 40
	mergedNotesKeptEvery    = 10
	mergedNotesDeadline     = 30 * time.Second
	mergedNotesPollInterval = 50 * time.Millisecond
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
	narsil := openPlainEngine(t, engine.Config{PatternWorkCap: engine.Some(int64(mergedNotesWorkCap))})
	createSpreadIndex(t, narsil, mergedNotesIndex, engine.Schema{"title": engine.FieldString,
		"note": engine.FieldString.WithOptions(engine.TextFieldPattern)}, 1)
	prefix := strings.Repeat("ab", mergedNotesRepeats)
	notes := insertNotes(t, narsil, prefix, 0, mergedNotesFrozenFirst)
	waitForOneFrozenSegment(t, narsil, "the first notes to freeze into one segment")
	if thinOlderSegments {
		var removed []string
		for at := range mergedNotesFrozenFirst {
			if at%mergedNotesKeptEvery != 0 {
				removed = append(removed, "note-"+strconv.Itoa(at))
			}
		}
		result, err := narsil.RemoveBatch(context.Background(), mergedNotesIndex, removed, engine.WriteOptions{})
		if err != nil || len(result.Failed) != 0 {
			t.Fatalf("removing %d notes failed: %v, with %d refused", len(removed), err, len(result.Failed))
		}
		for _, id := range removed {
			delete(notes, id)
		}
	}
	if searchBeforeMerge {
		requireMergedPatternMatches(t, narsil, notes, "before the merge")
	}
	for id, note := range insertNotes(t, narsil, prefix, mergedNotesFrozenFirst, mergedNotesWrittenAfter) {
		notes[id] = note
	}
	waitForOneFrozenSegment(t, narsil, "the idle merge to join the later notes with the first segment")
	requireMergedPatternMatches(t, narsil, notes, "after the merge")
}

func insertNotes(t *testing.T, narsil *engine.Narsil, prefix string, first, count int) map[string]string {
	t.Helper()
	notes := make(map[string]string, count)
	batch := make([]*engine.Document, 0, count)
	for number := first; number < first+count; number++ {
		id, note := "note-"+strconv.Itoa(number), prefix+strconv.Itoa(number)
		batch = append(batch, engine.DocumentFromMap(map[string]any{"id": id, "title": mergedNotesMarker, "note": note}))
		notes[id] = note
	}
	insertEvery(t, narsil, mergedNotesIndex, batch)
	return notes
}

func waitForOneFrozenSegment(t *testing.T, narsil *engine.Narsil, waitingFor string) {
	t.Helper()
	deadline := time.Now().Add(mergedNotesDeadline)
	for {
		segments, err := engine.PartitionSegmentsOf(context.Background(), narsil, mergedNotesIndex)
		if err != nil {
			t.Fatalf("reading the partition's segments failed: %v", err)
		}
		if len(segments) == 1 && segments[0].FrozenSegments == 1 && segments[0].GrowingDocuments == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("after %v of waiting for %s, the partition holds %+v", mergedNotesDeadline, waitingFor, segments)
		}
		time.Sleep(mergedNotesPollInterval)
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
