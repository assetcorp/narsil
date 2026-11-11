package engine_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"sort"
	"strings"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	diskTextIndex               = "ledgers"
	diskTextDocuments           = 240
	diskTextWordsPerDocument    = 7
	diskTextCompactionThreshold = 2
	diskTextSmallRounds         = 5
	diskTextUpdatedPerRound     = 6
	diskTextRemovedPerRound     = 2
	diskTextInsertedPerRound    = 3
	diskTextRewrittenShare      = 0.7
	diskTextHitLimit            = 2_000
	diskTextSeed                = 174_611
)

var diskTextVocabulary = []string{"copper", "lantern", "harbour", "meadow", "quartz", "violet", "timber", "anchor"}

type diskTextLedger struct {
	bodies   map[string]string
	inserted int
	revision int
}

func diskTextID(serial int) string {
	return fmt.Sprintf("ledger-%05d", serial)
}

func (ledger *diskTextLedger) nextBody(serial int) string {
	ledger.revision++
	source := rand.New(rand.NewSource(int64(diskTextSeed + serial*7_919 + ledger.revision)))
	words := make([]string, diskTextWordsPerDocument)
	for at := range words {
		words[at] = diskTextVocabulary[source.Intn(len(diskTextVocabulary))]
	}
	return strings.Join(words, " ")
}

func (ledger *diskTextLedger) heldIDs() []string {
	ids := make([]string, 0, len(ledger.bodies))
	for id := range ledger.bodies {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func (ledger *diskTextLedger) insert(t *testing.T, narsil *engine.Narsil, count int) {
	t.Helper()
	batch := make([]*engine.Document, count)
	written := map[string]string{}
	for at := range batch {
		id := diskTextID(ledger.inserted)
		body := ledger.nextBody(ledger.inserted)
		ledger.inserted++
		batch[at] = engine.DocumentFromMap(map[string]any{"id": id, "body": body})
		written[id] = body
	}
	result, err := narsil.InsertBatch(context.Background(), diskTextIndex, batch, engine.InsertOptions{})
	requireBatchWritten(t, "an insert", result, err)
	for id, body := range written {
		ledger.bodies[id] = body
	}
}

func (ledger *diskTextLedger) update(t *testing.T, narsil *engine.Narsil, ids []string) {
	t.Helper()
	updates := make([]engine.DocumentUpdate, len(ids))
	written := map[string]string{}
	for at, id := range ids {
		body := ledger.nextBody(at)
		updates[at] = engine.DocumentUpdate{DocID: id, Document: engine.DocumentFromMap(map[string]any{"body": body})}
		written[id] = body
	}
	result, err := narsil.UpdateBatch(context.Background(), diskTextIndex, updates, engine.WriteOptions{})
	requireBatchWritten(t, "an update", result, err)
	for id, body := range written {
		ledger.bodies[id] = body
	}
}

func (ledger *diskTextLedger) remove(t *testing.T, narsil *engine.Narsil, ids []string) {
	t.Helper()
	result, err := narsil.RemoveBatch(context.Background(), diskTextIndex, ids, engine.WriteOptions{})
	requireBatchWritten(t, "a removal", result, err)
	for _, id := range ids {
		delete(ledger.bodies, id)
	}
}

func (ledger *diskTextLedger) holding(matches func(words []string) bool) []string {
	var ids []string
	for id, body := range ledger.bodies {
		if matches(strings.Fields(body)) {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	return ids
}

func holdsAdjacent(first string, second string) func(words []string) bool {
	return func(words []string) bool {
		for at := 0; at+1 < len(words); at++ {
			if words[at] == first && words[at+1] == second {
				return true
			}
		}
		return false
	}
}

func holdsWordStarting(prefix string) func(words []string) bool {
	return func(words []string) bool {
		for _, word := range words {
			if strings.HasPrefix(word, prefix) {
				return true
			}
		}
		return false
	}
}

func diskTextHits(t *testing.T, narsil *engine.Narsil, params engine.QueryParams) []string {
	t.Helper()
	params.Limit = engine.Some(diskTextHitLimit)
	params.Document = engine.NoDocumentFields()
	result, err := narsil.Query(context.Background(), diskTextIndex, params)
	if err != nil {
		t.Fatalf("the search for %q failed with %s: %v", params.Term, codeOrMessage(err), err)
	}
	ids := make([]string, len(result.Hits))
	for at, hit := range result.Hits {
		ids[at] = hit.ID
	}
	sort.Strings(ids)
	return ids
}

func (ledger *diskTextLedger) requireAnswers(t *testing.T, narsil *engine.Narsil, moment string) {
	t.Helper()
	for _, first := range diskTextVocabulary[:4] {
		for _, second := range diskTextVocabulary[2:6] {
			expected := ledger.holding(holdsAdjacent(first, second))
			found := diskTextHits(t, narsil, engine.QueryParams{Term: `"` + first + " " + second + `"`})
			if strings.Join(found, ",") != strings.Join(expected, ",") {
				t.Fatalf("%s, the phrase %q %q matched %d documents where %d acknowledged documents hold it: %v against %v",
					moment, first, second, len(found), len(expected), found, expected)
			}
		}
	}
	for _, word := range diskTextVocabulary {
		prefix := word[:4]
		expected := ledger.holding(holdsWordStarting(prefix))
		found := diskTextHits(t, narsil, engine.QueryParams{Term: prefix, Prefix: true})
		if strings.Join(found, ",") != strings.Join(expected, ",") {
			t.Fatalf("%s, the prefix %q matched %d documents where %d acknowledged documents hold it", moment, prefix,
				len(found), len(expected))
		}
	}
}

func (ledger *diskTextLedger) requireExport(t *testing.T, narsil *engine.Narsil, moment string) {
	t.Helper()
	var exported bytes.Buffer
	if err := narsil.ExportDocuments(context.Background(), diskTextIndex, &exported); err != nil {
		t.Fatalf("%s, the export failed with %s: %v", moment, codeOrMessage(err), err)
	}
	scanner := bufio.NewScanner(&exported)
	scanner.Buffer(make([]byte, 0, 1<<16), maxExportLineBytes)
	seen := map[string]int{}
	for line := 0; scanner.Scan(); line++ {
		if line == 0 || strings.TrimSpace(scanner.Text()) == "" {
			continue
		}
		var document struct {
			ID   string `json:"id"`
			Body string `json:"body"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &document); err != nil {
			t.Fatalf("%s, line %d of the export does not parse: %v", moment, line+1, err)
		}
		seen[document.ID]++
		if body, held := ledger.bodies[document.ID]; !held || body != document.Body {
			t.Fatalf("%s, the export holds %q with the body %q, while the acknowledged body is %q (held: %t)", moment,
				document.ID, document.Body, body, held)
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("%s, the export cannot be read: %v", moment, err)
	}
	for _, id := range ledger.heldIDs() {
		if seen[id] != 1 {
			t.Fatalf("%s, the export holds %q %d times, where every acknowledged document belongs once", moment, id, seen[id])
		}
	}
}

func diskTextEngine(t *testing.T, directory string) *engine.Narsil {
	t.Helper()
	narsil, err := engine.New(context.Background(), engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)},
		Durability: &engine.DurabilityConfig{Directory: directory, Mode: engine.DurabilitySync,
			CompactionThreshold: engine.Some(diskTextCompactionThreshold)}})
	if err != nil {
		t.Fatalf("the engine refused to start with %s: %v", codeOrMessage(err), err)
	}
	return narsil
}

func diskTextCheckpoint(t *testing.T, narsil *engine.Narsil, moment string) {
	t.Helper()
	if err := narsil.Checkpoint(context.Background(), diskTextIndex); err != nil {
		t.Fatalf("%s, the checkpoint failed with %s: %v", moment, codeOrMessage(err), err)
	}
}

func TestTextStoredOnDiskKeepsEveryAnswerThroughCompactionRestartAndRestore(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	directory := t.TempDir()
	narsil := diskTextEngine(t, directory)
	if err := narsil.CreateIndex(ctx, diskTextIndex, engine.IndexConfig{Schema: engine.Schema{"body": engine.FieldString},
		Language: "english", TextStorage: engine.TextStorageDisk}); err != nil {
		t.Fatalf("the engine refused the index with %s: %v", codeOrMessage(err), err)
	}
	ledger := &diskTextLedger{bodies: map[string]string{}}
	ledger.insert(t, narsil, diskTextDocuments)
	diskTextCheckpoint(t, narsil, "after the first insert")
	for round := range diskTextSmallRounds {
		held := ledger.heldIDs()
		first := round * (diskTextUpdatedPerRound + diskTextRemovedPerRound)
		ledger.update(t, narsil, held[first:first+diskTextUpdatedPerRound])
		ledger.remove(t, narsil, held[first+diskTextUpdatedPerRound:first+diskTextUpdatedPerRound+diskTextRemovedPerRound])
		ledger.insert(t, narsil, diskTextInsertedPerRound)
		moment := fmt.Sprintf("after the small checkpoint %d", round+1)
		diskTextCheckpoint(t, narsil, moment)
		ledger.requireAnswers(t, narsil, moment)
	}
	ledger.requireExport(t, narsil, "before the restart")
	if err := narsil.Shutdown(ctx); err != nil {
		t.Fatalf("the engine failed to shut down with %s: %v", codeOrMessage(err), err)
	}

	narsil = diskTextEngine(t, directory)
	defer func() { _ = narsil.Shutdown(ctx) }()
	ledger.requireAnswers(t, narsil, "after the restart")
	ledger.requireExport(t, narsil, "after the restart")
	held := ledger.heldIDs()
	ledger.update(t, narsil, held[:int(float64(len(held))*diskTextRewrittenShare)])
	diskTextCheckpoint(t, narsil, "after most documents changed")
	ledger.requireAnswers(t, narsil, "after the checkpoint that rewrote most documents")
	ledger.requireExport(t, narsil, "after the checkpoint that rewrote most documents")

	var saved bytes.Buffer
	if err := narsil.Snapshot(ctx, diskTextIndex, engine.SnapshotOptions{}, &saved); err != nil {
		t.Fatalf("the snapshot failed with %s: %v", codeOrMessage(err), err)
	}
	restored := diskTextEngine(t, t.TempDir())
	defer func() { _ = restored.Shutdown(ctx) }()
	if err := restored.Restore(ctx, diskTextIndex, bytes.NewReader(saved.Bytes())); err != nil {
		t.Fatalf("the restore failed with %s: %v", codeOrMessage(err), err)
	}
	ledger.requireAnswers(t, restored, "after the restore into another engine")
	ledger.requireExport(t, restored, "after the restore into another engine")
}
