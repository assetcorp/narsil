package engine_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime/metrics"
	"slices"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	hostileChildVariable  = "NARSIL_HOSTILE_PHRASE_CHILD"
	hostileIndexName      = "phrases"
	hostileSpreadMarker   = "spread"
	hostileSpreadSpacing  = 1_000_000
	hostileWordCount      = 4_000
	hostileHeapCeiling    = 256 << 20
	hostileHeapPoll       = 2 * time.Millisecond
	hostileHeapExitCode   = 4
	hostileChildDeadline  = 2 * time.Minute
	hostileHitLimit       = 10
	hostilePlainWordsFrom = 20
	hostileHeapMetricName = "/memory/classes/heap/objects:bytes"
)

type spreadTokenizer struct{}

func (spreadTokenizer) Tokenize(text string) []engine.Token {
	words := strings.Fields(strings.ToLower(text))
	spacing := 1
	if slices.Contains(words, hostileSpreadMarker) {
		spacing = hostileSpreadSpacing
	}
	tokens := make([]engine.Token, len(words))
	for at, word := range words {
		tokens[at] = engine.Token{Token: word, Position: at * spacing}
	}
	return tokens
}

type hostileReport struct {
	Outcomes  map[string]string   `json:"outcomes"`
	Hits      map[string][]string `json:"hits"`
	PeakBytes uint64              `json:"peakBytes"`
}

func hostileWords() []string {
	words := make([]string, hostileWordCount)
	for at := range words {
		words[at] = "w" + strconv.Itoa(at)
	}
	words[0] = hostileSpreadMarker
	words[10] = "alpha"
	words[11] = "beta"
	return words
}

func hostileQueries() map[string]string {
	words := hostileWords()
	quoted := make([]string, len(words))
	for at, word := range words {
		quoted[at] = `"` + word + `"`
	}
	return map[string]string{
		"a phrase of thousands of words":   `"` + strings.Join(words, " ") + `"`,
		"three words spread apart":         `"spread alpha beta"`,
		"thousands of one-word phrases":    strings.Join(quoted, " "),
		"two adjacent words in a phrase":   `"alpha beta"`,
		"thousands of words with no quote": strings.Join(words[hostilePlainWordsFrom:], " "),
	}
}

func watchHeap(stop <-chan struct{}, peak *atomic.Uint64) {
	sample := []metrics.Sample{{Name: hostileHeapMetricName}}
	ticker := time.NewTicker(hostileHeapPoll)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
		}
		metrics.Read(sample)
		used := sample[0].Value.Uint64()
		if used > peak.Load() {
			peak.Store(used)
		}
		if used > hostileHeapCeiling {
			fmt.Fprintf(os.Stderr, "the heap held %d bytes, past the ceiling of %d\n", used, hostileHeapCeiling)
			os.Exit(hostileHeapExitCode)
		}
	}
}

func runHostilePhraseChild(output io.Writer) error {
	ctx := context.Background()
	stop := make(chan struct{})
	var peak atomic.Uint64
	go watchHeap(stop, &peak)
	defer close(stop)
	narsil, err := engine.New(ctx, engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)}})
	if err != nil {
		return err
	}
	defer func() { _ = narsil.Shutdown(ctx) }()
	if err := narsil.CreateIndex(ctx, hostileIndexName, engine.IndexConfig{Schema: engine.Schema{"body": engine.FieldString},
		Tokenizer: engine.UseTokenizer(spreadTokenizer{}), TrackPositions: engine.Some(true)}); err != nil {
		return err
	}
	documents := map[string]string{"near": "alpha beta gamma", "far": strings.Join(hostileWords(), " ")}
	for id, body := range documents {
		if _, err := narsil.Insert(ctx, hostileIndexName, engine.Document{"body": body}, id, engine.InsertOptions{}); err != nil {
			return err
		}
	}
	report := hostileReport{Outcomes: map[string]string{}, Hits: map[string][]string{}}
	for name, term := range hostileQueries() {
		result, err := narsil.Query(ctx, hostileIndexName, engine.QueryParams{Term: term, Limit: engine.Some(hostileHitLimit),
			Document: engine.NoDocumentFields()})
		if err != nil {
			report.Outcomes[name] = codeOrMessage(err)
			continue
		}
		report.Outcomes[name] = "OK"
		ids := []string{}
		for _, hit := range result.Hits {
			ids = append(ids, hit.ID)
		}
		slices.Sort(ids)
		report.Hits[name] = ids
	}
	report.PeakBytes = peak.Load()
	return json.NewEncoder(output).Encode(report)
}

func TestHostilePhraseQueriesStayWithinBoundedMemory(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatalf("finding the test binary failed: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), hostileChildDeadline)
	defer cancel()
	child := exec.CommandContext(ctx, executable, "-test.run=^$")
	child.Env = append(os.Environ(), hostileChildVariable+"=1")
	var stdout, stderr bytes.Buffer
	child.Stdout = &stdout
	child.Stderr = &stderr
	if err := child.Run(); err != nil {
		t.Fatalf("the hostile phrase queries did not finish within %s and %d heap bytes: %v\n%s", hostileChildDeadline,
			hostileHeapCeiling, err, stderr.String())
	}
	report := hostileReport{}
	if err := json.Unmarshal(stdout.Bytes(), &report); err != nil {
		t.Fatalf("reading the child's report failed: %v\n%s", err, stdout.String())
	}
	want := map[string]string{
		"a phrase of thousands of words":   "SEARCH_INVALID_PHRASE",
		"three words spread apart":         "SEARCH_INVALID_PHRASE",
		"thousands of one-word phrases":    "SEARCH_INVALID_PHRASE",
		"two adjacent words in a phrase":   "OK",
		"thousands of words with no quote": "OK",
	}
	for name, code := range want {
		if report.Outcomes[name] != code {
			t.Errorf("%s gave %q, where the phrase limits of the specification give %q", name, report.Outcomes[name], code)
		}
	}
	wantHits := map[string][]string{"two adjacent words in a phrase": {"near"}, "thousands of words with no quote": {"far"}}
	for name, ids := range wantHits {
		if !slices.Equal(report.Hits[name], ids) {
			t.Errorf("%s returned %v, while only %v holds those words at those positions", name, report.Hits[name], ids)
		}
	}
	t.Logf("the child's heap peaked at %d bytes", report.PeakBytes)
}
