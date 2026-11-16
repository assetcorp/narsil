package engine_test

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	ruleDocuments      = 400
	ruleInsertBatch    = 200
	ruleWordsTokenizer = "words"
	ruleDashTokenizer  = "dashes"
	ruleHeldTokenizer  = "held"
	liveEngineLockName = ".narsil.lock"
)

type splitTokenizer func(string) []engine.Token

func (split splitTokenizer) Tokenize(text string) []engine.Token {
	return split(text)
}

func dashedWords(text string) []engine.Token {
	words := strings.FieldsFunc(text, func(r rune) bool { return r == ' ' || r == '-' })
	tokens := make([]engine.Token, len(words))
	for at, word := range words {
		tokens[at] = engine.Token{Token: strings.ToLower(word), Position: at}
	}
	return tokens
}

type heldTokenizer struct {
	held    atomic.Bool
	entered chan struct{}
	enter   sync.Once
	release chan struct{}
	free    sync.Once
}

func newHeldTokenizer() *heldTokenizer {
	return &heldTokenizer{entered: make(chan struct{}), release: make(chan struct{})}
}

func (held *heldTokenizer) Tokenize(text string) []engine.Token {
	if held.held.Load() {
		held.enter.Do(func() { close(held.entered) })
		<-held.release
	}
	return dashedWords(text)
}

func (held *heldTokenizer) letGo() {
	held.free.Do(func() { close(held.release) })
}

func (held *heldTokenizer) awaitEntered(t *testing.T, moment string) {
	t.Helper()
	select {
	case <-held.entered:
	case <-time.After(callbackDeadline):
		t.Fatalf("%s, the new tokenizer was never called within %s", moment, callbackDeadline)
	}
}

func ruleEngine(t *testing.T, directory string, held *heldTokenizer) *engine.Narsil {
	t.Helper()
	config := engine.Config{
		Tokenizers: map[string]engine.Tokenizer{ruleWordsTokenizer: splitTokenizer(lowercaseWords),
			ruleDashTokenizer: splitTokenizer(dashedWords), ruleHeldTokenizer: held},
		Workers: engine.WorkerConfig{Enabled: engine.Some(false)},
	}
	if directory != "" {
		config.Durability = &engine.DurabilityConfig{Directory: directory, Mode: engine.DurabilitySync,
			CheckpointInterval: engine.Some(time.Duration(0)), CheckpointMutationThreshold: engine.Some(crashDistantThreshold)}
	}
	narsil, err := engine.New(context.Background(), config)
	if err != nil {
		t.Fatalf("the engine refused to start with %s: %v", codeOrMessage(err), err)
	}
	return narsil
}

func ruleID(at int) string {
	return fmt.Sprintf("harbour-%04d", at)
}

func ruleTitle(at int) string {
	return fmt.Sprintf("harbour-q%04d pier", at)
}

func fillRuleIndex(t *testing.T, narsil *engine.Narsil) {
	t.Helper()
	ctx := context.Background()
	if err := narsil.CreateIndex(ctx, callbackIndex, engine.IndexConfig{Schema: engine.Schema{"title": engine.FieldString},
		Tokenizer: engine.NamedTokenizer(ruleWordsTokenizer)}); err != nil {
		t.Fatal(err)
	}
	for first := 0; first < ruleDocuments; first += ruleInsertBatch {
		batch := make([]*engine.Document, 0, ruleInsertBatch)
		for at := first; at < min(ruleDocuments, first+ruleInsertBatch); at++ {
			batch = append(batch, engine.DocumentFromMap(map[string]any{"id": ruleID(at), "title": ruleTitle(at)}))
		}
		result, err := narsil.InsertBatch(ctx, callbackIndex, batch, engine.InsertOptions{})
		if err != nil || len(result.Failed) > 0 {
			t.Fatalf("filling the index failed: %v %v", err, result.Failed)
		}
	}
}

type ruleSettings int

const (
	underWords ruleSettings = iota
	underDashes
)

func termHits(t *testing.T, narsil *engine.Narsil, term string) []string {
	t.Helper()
	result, err := narsil.Query(context.Background(), callbackIndex, engine.QueryParams{Term: term, Limit: engine.Some(5)})
	if err != nil {
		t.Fatalf("a search for %q failed with %s: %v", term, codeOrMessage(err), err)
	}
	return hitIDs(result.Hits)
}

func requireHits(t *testing.T, narsil *engine.Narsil, label string, term string, want []string) {
	t.Helper()
	got := termHits(t, narsil, term)
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("%s, a search for %q found %v; the settings in force find %v", label, term, got, want)
	}
}

func requireAnswersUnder(t *testing.T, narsil *engine.Narsil, settings ruleSettings, label string) {
	t.Helper()
	for at := range ruleDocuments {
		whole, half := fmt.Sprintf("harbour-q%04d", at), fmt.Sprintf("q%04d", at)
		if settings == underDashes {
			requireHits(t, narsil, label, half, []string{ruleID(at)})
			continue
		}
		requireHits(t, narsil, label, whole, []string{ruleID(at)})
		requireHits(t, narsil, label, half, []string{})
	}
}

func changeOutcome(narsil *engine.Narsil, change engine.AnalysisChange) <-chan error {
	outcome := make(chan error, 1)
	go func() { outcome <- narsil.ChangeAnalysis(context.Background(), callbackIndex, change) }()
	return outcome
}

func outcomeWithin(t *testing.T, outcome <-chan error, label string) error {
	t.Helper()
	select {
	case err := <-outcome:
		return err
	case <-time.After(callbackDeadline):
		t.Fatalf("%s did not return within %s", label, callbackDeadline)
		return nil
	}
}

func TestALaterAnalysisChangeReplacesOneThatIsStillBuildingAndTellsItsCaller(t *testing.T) {
	t.Parallel()
	held := newHeldTokenizer()
	narsil := ruleEngine(t, "", held)
	defer shutDownWithin(t, narsil, "after the test")
	defer held.letGo()
	fillRuleIndex(t, narsil)
	held.held.Store(true)
	earlier := changeOutcome(narsil, engine.AnalysisChange{Tokenizer: engine.ChangeToRegisteredTokenizer(ruleHeldTokenizer)})
	held.awaitEntered(t, "while the earlier change built")
	later := changeOutcome(narsil, engine.AnalysisChange{Tokenizer: engine.ChangeToRegisteredTokenizer(ruleDashTokenizer)})
	requireCode(t, outcomeWithin(t, earlier, "the earlier change"), engine.CodeAnalysisChangeReplaced, "the earlier change")
	held.letGo()
	if err := outcomeWithin(t, later, "the later change"); err != nil {
		t.Fatalf("the later change failed with %s: %v", codeOrMessage(err), err)
	}
	requireAnswersUnder(t, narsil, underDashes, "after the later change")
}

type stalledReader struct {
	data    []byte
	served  int
	stalled chan struct{}
	release chan struct{}
	once    sync.Once
}

func (reader *stalledReader) Read(into []byte) (int, error) {
	half := len(reader.data) / 2
	if reader.served >= half {
		reader.once.Do(func() { close(reader.stalled) })
		<-reader.release
	}
	if reader.served >= len(reader.data) {
		return 0, io.EOF
	}
	end := len(reader.data)
	if reader.served < half {
		end = half
	}
	read := copy(into, reader.data[reader.served:end])
	reader.served += read
	return read, nil
}

func restoreOutcome(narsil *engine.Narsil, source io.Reader) <-chan error {
	outcome := make(chan error, 1)
	go func() { outcome <- narsil.Restore(context.Background(), callbackIndex, source) }()
	return outcome
}

func TestARestoreRefusesAnAnalysisChangeAtTheRequestAndAtTheSwitchAndLeavesNoPendingChange(t *testing.T) {
	t.Parallel()
	directory := t.TempDir()
	held := newHeldTokenizer()
	narsil := ruleEngine(t, directory, held)
	defer held.letGo()
	fillRuleIndex(t, narsil)
	archive := snapshotOf(t, narsil, callbackIndex)
	stalled := &stalledReader{data: archive, stalled: make(chan struct{}), release: make(chan struct{})}
	restored := restoreOutcome(narsil, stalled)
	select {
	case <-stalled.stalled:
	case <-time.After(callbackDeadline):
		t.Fatalf("the restore never read half of its archive within %s", callbackDeadline)
	}
	asked := changeOutcome(narsil, engine.AnalysisChange{Tokenizer: engine.ChangeToRegisteredTokenizer(ruleDashTokenizer)})
	requireCode(t, outcomeWithin(t, asked, "the change asked for during a restore"), engine.CodeAnalysisChangeReplaced,
		"the change asked for during a restore")
	close(stalled.release)
	if err := outcomeWithin(t, restored, "the stalled restore"); err != nil {
		t.Fatalf("the stalled restore failed with %s: %v", codeOrMessage(err), err)
	}
	held.held.Store(true)
	building := changeOutcome(narsil, engine.AnalysisChange{Tokenizer: engine.ChangeToRegisteredTokenizer(ruleHeldTokenizer)})
	held.awaitEntered(t, "before the restore")
	restored = restoreOutcome(narsil, bytes.NewReader(archive))
	requireCode(t, outcomeWithin(t, building, "the change that a restore overtook"), engine.CodeAnalysisChangeReplaced,
		"the change that a restore overtook")
	held.letGo()
	if err := outcomeWithin(t, restored, "the restore during a change"); err != nil {
		t.Fatalf("the restore during a change failed with %s: %v", codeOrMessage(err), err)
	}
	requireAnswersUnder(t, narsil, underWords, "after both restores")
	shutDownWithin(t, narsil, "after both restores")
	reopened := ruleEngine(t, directory, newHeldTokenizer())
	defer shutDownWithin(t, reopened, "after the restart")
	if _, err := finishedWithin(t, "the rebuild after the restart", func() (struct{}, error) {
		return struct{}{}, reopened.RebuildAnalysis(context.Background(), callbackIndex)
	}); err != nil {
		t.Fatalf("the rebuild after the restart failed with %s: %v", codeOrMessage(err), err)
	}
	requireAnswersUnder(t, reopened, underWords, "after a restart and a rebuild of any pending change")
}

func copyDirectory(from string, to string) error {
	return filepath.WalkDir(from, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		relative, err := filepath.Rel(from, path)
		if err != nil {
			return err
		}
		target := filepath.Join(to, relative)
		if entry.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		if entry.Name() == liveEngineLockName {
			return nil
		}
		data, err := os.ReadFile(path)
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, 0o644)
	})
}

func TestAChangeAfterASwitchRecoversFromACrashWhileItBuilds(t *testing.T) {
	t.Parallel()
	directory, crashed := t.TempDir(), t.TempDir()
	held := newHeldTokenizer()
	narsil := ruleEngine(t, directory, held)
	defer held.letGo()
	fillRuleIndex(t, narsil)
	if err := narsil.Checkpoint(context.Background(), callbackIndex); err != nil {
		t.Fatalf("the checkpoint before the first change failed with %s: %v", codeOrMessage(err), err)
	}
	if err := narsil.ChangeAnalysis(context.Background(), callbackIndex,
		engine.AnalysisChange{Tokenizer: engine.ChangeToRegisteredTokenizer(ruleDashTokenizer)}); err != nil {
		t.Fatalf("the first change failed with %s: %v", codeOrMessage(err), err)
	}
	held.held.Store(true)
	second := changeOutcome(narsil, engine.AnalysisChange{Tokenizer: engine.ChangeToRegisteredTokenizer(ruleHeldTokenizer)})
	held.awaitEntered(t, "while the second change built")
	if err := copyDirectory(directory, crashed); err != nil {
		t.Fatalf("copying the directory as a crash would leave it failed: %v", err)
	}
	held.letGo()
	if err := outcomeWithin(t, second, "the second change"); err != nil {
		t.Fatalf("the second change failed with %s: %v", codeOrMessage(err), err)
	}
	shutDownWithin(t, narsil, "after the second change")
	recovered := ruleEngine(t, crashed, newHeldTokenizer())
	defer shutDownWithin(t, recovered, "after the recovery")
	if len(recovered.ListIndexes()) != 1 {
		t.Fatalf("the directory that a crash during the second change left recovered %d indexes, not 1",
			len(recovered.ListIndexes()))
	}
	requireAnswersUnder(t, recovered, underDashes, "right after the recovery")
	if _, err := finishedWithin(t, "the resumed second change", func() (struct{}, error) {
		return struct{}{}, recovered.RebuildAnalysis(context.Background(), callbackIndex)
	}); err != nil {
		t.Fatalf("the resumed second change failed with %s: %v", codeOrMessage(err), err)
	}
	requireAnswersUnder(t, recovered, underDashes, "after the resumed second change")
}
