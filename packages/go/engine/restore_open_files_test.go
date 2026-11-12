package engine_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	retiringRerankAdapter      = "retiring"
	retiringRerankCalls        = 2
	retiringSearchedWord       = "copper"
	retiringHitLimit           = 5
	retiringRerankTimeout      = 10 * time.Minute
	retiredFolderPrefix        = ".retired-"
	restoreJournalFilePrefix   = ".swap-"
	rebuildRaceDocuments       = 10_000
	rebuildRaceInsertBatch     = 1_000
	rebuildRaceRounds          = 4
	rebuildRaceArchivedFirstID = 1_000_000
	writesAfterEachRestore     = 3
	openFileDescriptorsFolder  = "/proc/self/fd"
	stopWordsThatStartARebuild = "lantern"
)

func openFilesEngine(t *testing.T, directory string) *engine.Narsil {
	t.Helper()
	narsil, err := engine.New(context.Background(), engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)},
		RerankTimeout: engine.Some(retiringRerankTimeout),
		Durability: &engine.DurabilityConfig{Directory: directory, Mode: engine.DurabilitySync,
			CompactionThreshold: engine.Some(diskTextCompactionThreshold)}})
	if err != nil {
		t.Fatalf("the engine refused to start with %s: %v", codeOrMessage(err), err)
	}
	return narsil
}

func resolvedDirectory(t *testing.T) string {
	t.Helper()
	resolved, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("the test directory cannot be resolved: %v", err)
	}
	return resolved
}

func filesOpenUnderRetiredFolders(directory string) ([]string, error) {
	if runtime.GOOS != "linux" {
		return nil, nil
	}
	descriptors, err := os.ReadDir(openFileDescriptorsFolder)
	if err != nil {
		return nil, err
	}
	retired := filepath.Join(directory, retiredFolderPrefix)
	var open []string
	for _, descriptor := range descriptors {
		target, err := os.Readlink(filepath.Join(openFileDescriptorsFolder, descriptor.Name()))
		if err == nil && strings.HasPrefix(target, retired) {
			open = append(open, target)
		}
	}
	return open, nil
}

func requireNoRetiredFileOpen(t *testing.T, directory string, moment string) {
	t.Helper()
	open, err := filesOpenUnderRetiredFolders(directory)
	if err != nil {
		t.Fatalf("%s, the open files cannot be listed: %v", moment, err)
	}
	if len(open) > 0 {
		t.Fatalf("%s, the process holds %d files open under a retired index folder: %v", moment, len(open), open)
	}
}

func archivedLedger(t *testing.T, offset int) (*diskTextLedger, []byte) {
	t.Helper()
	ctx := context.Background()
	source := diskTextEngine(t, t.TempDir())
	defer func() { _ = source.Shutdown(ctx) }()
	createDiskTextIndex(t, source)
	ledger := &diskTextLedger{bodies: map[string]string{}, inserted: offset}
	ledger.insert(t, source, diskTextDocuments)
	diskTextCheckpoint(t, source, "before the snapshot")
	return ledger, snapshotOf(t, source, diskTextIndex)
}

func (ledger *diskTextLedger) copied() *diskTextLedger {
	bodies := make(map[string]string, len(ledger.bodies))
	for id, body := range ledger.bodies {
		bodies[id] = body
	}
	return &diskTextLedger{bodies: bodies, inserted: ledger.inserted, revision: ledger.revision}
}

func (ledger *diskTextLedger) requireDurableAcrossRestart(t *testing.T, narsil *engine.Narsil, directory string,
	moment string) *engine.Narsil {
	t.Helper()
	ledger.insert(t, narsil, writesAfterEachRestore)
	ledger.requireAnswers(t, narsil, moment+", after later writes")
	ledger.requireExport(t, narsil, moment+", after later writes")
	if err := narsil.Shutdown(context.Background()); err != nil {
		t.Fatalf("%s, the engine failed to shut down with %s: %v", moment, codeOrMessage(err), err)
	}
	restarted := openFilesEngine(t, directory)
	ledger.requireAnswers(t, restarted, moment+", after the restart")
	ledger.requireExport(t, restarted, moment+", after the restart")
	return restarted
}

type retiringReranker struct {
	mu        sync.Mutex
	calls     int
	failure   error
	openFiles []string
}

func (r *retiringReranker) fail(err error) error {
	r.failure = errors.Join(r.failure, err)
	return err
}

func (r *retiringReranker) register(t *testing.T, narsil *engine.Narsil, directory string, archive []byte) {
	t.Helper()
	reranker := &callbackReranker{rerank: func(_ string, documents []string) ([]float64, error) {
		r.mu.Lock()
		defer r.mu.Unlock()
		r.calls++
		if r.calls == 1 {
			if err := narsil.ChangeAnalysis(context.Background(), diskTextIndex,
				engine.AnalysisChange{StopWords: engine.ChangeToStopWordList(stopWordsThatStartARebuild)}); err != nil {
				return nil, r.fail(err)
			}
			if err := restoreArchive(narsil, diskTextIndex, archive); err != nil {
				return nil, r.fail(err)
			}
			open, err := filesOpenUnderRetiredFolders(directory)
			if err != nil {
				return nil, r.fail(err)
			}
			r.openFiles = open
		}
		return make([]float64, len(documents)), nil
	}}
	if err := narsil.RegisterRerankAdapter(retiringRerankAdapter, reranker); err != nil {
		t.Fatalf("registering the retiring reranker failed: %v", err)
	}
}

func holdsWord(wanted string) func(words []string) bool {
	return func(words []string) bool { return slices.Contains(words, wanted) }
}

func TestARestoreClosesTheIndexThatAnAnalysisChangeRetiredWhileARerankedQueryStillHeldIt(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	archived, archive := archivedLedger(t, 0)
	directory := resolvedDirectory(t)
	target := openFilesEngine(t, directory)
	createDiskTextIndex(t, target)
	replaced := &diskTextLedger{bodies: map[string]string{}, inserted: diskTextDocuments}
	replaced.insert(t, target, diskTextDocuments)
	diskTextCheckpoint(t, target, "before the reranked query")
	reranker := &retiringReranker{}
	reranker.register(t, target, directory, archive)

	result, err := target.Query(ctx, diskTextIndex, engine.QueryParams{Term: retiringSearchedWord,
		Limit:  engine.Some(retiringHitLimit),
		Rerank: &engine.RerankConfig{Adapter: retiringRerankAdapter, Fields: []string{"body"}}})
	if reranker.failure != nil {
		t.Fatalf("inside the rerank call, the analysis change or the restore failed with %s: %v",
			codeOrMessage(reranker.failure), reranker.failure)
	}
	if err != nil {
		t.Fatalf("the reranked query failed with %s: %v", codeOrMessage(err), err)
	}
	if len(reranker.openFiles) > 0 {
		t.Fatalf("once the restore returned, the process held %d files open under a retired index folder: %v",
			len(reranker.openFiles), reranker.openFiles)
	}
	if reranker.calls != retiringRerankCalls {
		t.Fatalf("the reranker ran %d times, expected %d", reranker.calls, retiringRerankCalls)
	}
	expected := archived.holding(holdsWord(retiringSearchedWord))
	if result.Count != len(expected) || len(result.Hits) != min(retiringHitLimit, len(expected)) {
		t.Fatalf("the reranked query counted %d documents and returned %d hits, while the archive holds %d documents with %q",
			result.Count, len(result.Hits), len(expected), retiringSearchedWord)
	}
	for _, hit := range result.Hits {
		if !slices.Contains(expected, hit.ID) {
			t.Fatalf("the reranked query returned %q, which the restored archive does not hold with %q", hit.ID,
				retiringSearchedWord)
		}
		if hit.Document == nil {
			t.Fatalf("the reranked query returned %q without its document", hit.ID)
		}
		body, _ := hit.Document.Get("body")
		if body != archived.bodies[hit.ID] {
			t.Fatalf("the reranked query returned %q with the body %v, while the restored archive holds %q", hit.ID, body,
				archived.bodies[hit.ID])
		}
	}
	archived.requireAnswers(t, target, "after the restore under the reranked query")
	requireNoRetiredFileOpen(t, directory, "after the reranked query")
	target = archived.requireDurableAcrossRestart(t, target, directory, "after the restore under the reranked query")
	_ = target.Shutdown(ctx)
}

func rebuildStarted(narsil *engine.Narsil) (<-chan struct{}, func()) {
	started := make(chan struct{})
	var once sync.Once
	unsubscribe := narsil.On(engine.EventHandlers{AnalysisRebuild: func(event engine.AnalysisRebuildEvent) {
		if event.IndexName == diskTextIndex && event.Status == engine.ProgressStarted {
			once.Do(func() { close(started) })
		}
	}})
	return started, unsubscribe
}

func (ledger *diskTextLedger) insertInBatches(t *testing.T, narsil *engine.Narsil, count int) {
	t.Helper()
	for written := 0; written < count; written += rebuildRaceInsertBatch {
		ledger.insert(t, narsil, min(rebuildRaceInsertBatch, count-written))
	}
}

func TestARestoreThatStopsAnAnalysisRebuildInTheMiddleOfItsReadsLeavesTheRestoredIndexWritable(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	archived, archive := archivedLedger(t, rebuildRaceArchivedFirstID)
	directory := resolvedDirectory(t)
	target := openFilesEngine(t, directory)
	createDiskTextIndex(t, target)
	replaced := &diskTextLedger{bodies: map[string]string{}}
	expected := archived
	for round := range rebuildRaceRounds {
		replaced.insertInBatches(t, target, rebuildRaceDocuments)
		diskTextCheckpoint(t, target, "before the analysis change")
		started, unsubscribe := rebuildStarted(target)
		changed := make(chan error, 1)
		go func() {
			changed <- target.ChangeAnalysis(ctx, diskTextIndex,
				engine.AnalysisChange{StopWords: engine.ChangeToStopWordList(stopWordsThatStartARebuild)})
		}()
		<-started
		unsubscribe()
		if err := restoreArchive(target, diskTextIndex, archive); err != nil {
			t.Fatalf("in round %d, the restore that stopped the analysis rebuild failed with %s: %v", round+1,
				codeOrMessage(err), err)
		}
		if err := <-changed; err != nil && engine.ErrorCode(err) != engine.CodeAnalysisChangeReplaced {
			t.Fatalf("in round %d, the analysis change failed with %s: %v", round+1, codeOrMessage(err), err)
		}
		requireNoRetiredFileOpen(t, directory, "after the restore that stopped the analysis rebuild")
		expected = archived.copied()
		expected.inserted = replaced.inserted
		expected.insert(t, target, writesAfterEachRestore)
		expected.requireAnswers(t, target, "after the restore that stopped the analysis rebuild")
		replaced.inserted = expected.inserted
	}
	target = expected.requireDurableAcrossRestart(t, target, directory, "after the last restore that stopped a rebuild")
	_ = target.Shutdown(ctx)
}

func TestARestoreWhoseJournalCannotBeWrittenLeavesTheReplacedIndexWritableAndDurable(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	archived, archive := archivedLedger(t, 0)
	directory := resolvedDirectory(t)
	target := openFilesEngine(t, directory)
	createDiskTextIndex(t, target)
	replaced := &diskTextLedger{bodies: map[string]string{}, inserted: diskTextDocuments}
	replaced.insert(t, target, diskTextDocuments)
	diskTextCheckpoint(t, target, "before the refused restore")
	digest := sha256.Sum256([]byte(diskTextIndex))
	blocked := filepath.Join(directory, restoreJournalFilePrefix+hex.EncodeToString(digest[:]))
	if err := os.Mkdir(blocked, 0o700); err != nil {
		t.Fatalf("the folder that blocks the restore journal cannot be made: %v", err)
	}
	err := restoreArchive(target, diskTextIndex, archive)
	if engine.ErrorCode(err) != engine.CodePersistenceSaveFailed {
		t.Fatalf("the restore whose journal is blocked returned %s, expected %s: %v", codeOrMessage(err),
			engine.CodePersistenceSaveFailed, err)
	}
	replaced.requireAnswers(t, target, "after the refused restore")
	target = replaced.requireDurableAcrossRestart(t, target, directory, "after the refused restore")
	if err := os.RemoveAll(blocked); err != nil {
		t.Fatalf("the folder that blocks the restore journal cannot be removed: %v", err)
	}
	if err := restoreArchive(target, diskTextIndex, archive); err != nil {
		t.Fatalf("the restore once the journal was unblocked failed with %s: %v", codeOrMessage(err), err)
	}
	requireNoRetiredFileOpen(t, directory, "after the restore once the journal was unblocked")
	archived.inserted = replaced.inserted
	target = archived.requireDurableAcrossRestart(t, target, directory, "after the restore once the journal was unblocked")
	_ = target.Shutdown(ctx)
}
