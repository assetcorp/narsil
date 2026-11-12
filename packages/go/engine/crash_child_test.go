package engine_test

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	crashDirectoryVariable = "NARSIL_CRASH_CHILD_DIRECTORY"
	crashLogVariable       = "NARSIL_CRASH_CHILD_LOG"
	crashModeVariable      = "NARSIL_CRASH_CHILD_MODE"
	crashSeedVariable      = "NARSIL_CRASH_CHILD_SEED"
	crashIndexName         = "ledger"
	crashSlotCount         = 4_000
	crashInsertBatch       = 25
	crashCheckpointPause   = 2 * time.Millisecond
	crashModeInserts       = "inserts"
	crashModeCheckpoints   = "checkpoints"
	crashModeMerges        = "merges"
	crashModeRewrites      = "rewrites"
	crashMergeThreshold    = 1
	crashDistantThreshold  = 1_000_000_000
	crashDocsPerPartition  = 1_500
)

const (
	crashRewriteSlotCount        = 300
	crashRewriteDocsPerPartition = 120
)

func crashSlotsOf(mode string) int {
	if mode == crashModeRewrites {
		return crashRewriteSlotCount
	}
	return crashSlotCount
}

var crashWords = []string{"amber", "basil", "cedar", "delta", "ember", "fjord", "garnet", "harbor", "indigo", "juniper",
	"kelp", "lumen", "maple", "nectar", "onyx", "pepper", "quartz", "russet", "saffron", "tundra"}

type crashStep struct {
	Op        string                    `json:"op"`
	Documents map[string]map[string]any `json:"documents,omitempty"`
	ID        string                    `json:"id,omitempty"`
}

func TestMain(m *testing.M) {
	if os.Getenv(hostileChildVariable) != "" {
		if err := runHostilePhraseChild(os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, "the hostile phrase child stopped:", engine.ErrorCode(err), err)
			os.Exit(3)
		}
		os.Exit(0)
	}
	if directory := os.Getenv(growthDirectoryVariable); directory != "" {
		if err := runGrowthCheckpointChild(directory, os.Getenv(growthReadyVariable)); err != nil {
			fmt.Fprintln(os.Stderr, "the growth checkpoint child stopped:", engine.ErrorCode(err), err)
			os.Exit(3)
		}
		os.Exit(0)
	}
	if directory := os.Getenv(crashDirectoryVariable); directory != "" {
		seed, _ := strconv.ParseInt(os.Getenv(crashSeedVariable), 10, 64)
		if err := runCrashChild(directory, os.Getenv(crashLogVariable), os.Getenv(crashModeVariable), seed); err != nil {
			fmt.Fprintln(os.Stderr, "the crash child stopped:", engine.ErrorCode(err), err)
			os.Exit(3)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func crashSlotID(slot int) string {
	return fmt.Sprintf("entry-%05d", slot)
}

func crashDocument(random *rand.Rand, slot int) map[string]any {
	words := make([]string, 30)
	for at := range words {
		words[at] = crashWords[random.Intn(len(crashWords))]
	}
	return map[string]any{
		"title":     crashWords[slot%len(crashWords)] + " " + crashWords[random.Intn(len(crashWords))],
		"body":      strings.Join(words, " "),
		"rank":      float64(random.Intn(100_000)),
		"embedding": []any{float64(random.Intn(16)) / 8, float64(random.Intn(16)) / 8, float64(slot%8) / 8, 1.0},
	}
}

func crashDurability(directory string, mode string) *engine.DurabilityConfig {
	durability := &engine.DurabilityConfig{Directory: directory, Mode: engine.DurabilitySync,
		CheckpointMutationThreshold: engine.Some(crashDistantThreshold)}
	if mode == crashModeMerges {
		durability.CompactionThreshold = engine.Some(crashMergeThreshold)
	}
	return durability
}

func crashIndexConfig(mode string) engine.IndexConfig {
	config := engine.IndexConfig{Schema: engine.Schema{"title": engine.FieldString, "body": engine.FieldString,
		"rank": engine.FieldNumber, "embedding": engine.VectorFieldType(4)},
		Partitions: engine.PartitionConfig{MaxDocsPerPartition: engine.Some(crashDocsPerPartition), MaxPartitions: engine.Some(3)}}
	if mode == crashModeRewrites {
		config.TextStorage = engine.TextStorageDisk
		config.Partitions.MaxDocsPerPartition = engine.Some(crashRewriteDocsPerPartition)
	}
	return config
}

type crashJournal struct {
	mu   sync.Mutex
	file *os.File
}

func (journal *crashJournal) note(line string) error {
	journal.mu.Lock()
	defer journal.mu.Unlock()
	_, err := journal.file.WriteString(line + "\n")
	return err
}

func runCrashChild(directory string, logPath string, mode string, seed int64) error {
	ctx := context.Background()
	file, err := os.OpenFile(logPath, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	journal := &crashJournal{file: file}
	narsil, err := engine.New(ctx, engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)},
		Durability: crashDurability(directory, mode)})
	if err != nil {
		return err
	}
	if len(narsil.ListIndexes()) == 0 {
		if err := narsil.CreateIndex(ctx, crashIndexName, crashIndexConfig(mode)); err != nil {
			return err
		}
	}
	held, err := exportedDocuments(ctx, narsil, crashIndexName)
	if err != nil {
		return err
	}
	if mode != crashModeInserts {
		go func() {
			for {
				_ = journal.note("checkpoint-start")
				if err := narsil.Checkpoint(ctx, crashIndexName); err != nil {
					_ = journal.note("checkpoint-error " + engine.ErrorCode(err))
				}
				_ = journal.note("checkpoint-end")
				time.Sleep(crashCheckpointPause)
			}
		}()
	}
	random := rand.New(rand.NewSource(seed))
	for {
		step := nextCrashStep(random, held, crashSlotsOf(mode))
		encoded, err := json.Marshal(step)
		if err != nil {
			return err
		}
		if err := journal.note("begin " + string(encoded)); err != nil {
			return err
		}
		if err := applyCrashStep(ctx, narsil, step); err != nil {
			return err
		}
		if err := journal.note("ack"); err != nil {
			return err
		}
		for id, document := range step.Documents {
			held[id] = document
		}
		if step.Op == "remove" {
			delete(held, step.ID)
		}
	}
}

func nextCrashStep(random *rand.Rand, held map[string]any, slots int) crashStep {
	slot := random.Intn(slots)
	id := crashSlotID(slot)
	if _, present := held[id]; present {
		if random.Intn(3) == 0 {
			return crashStep{Op: "remove", ID: id}
		}
		return crashStep{Op: "update", ID: id, Documents: map[string]map[string]any{id: crashDocument(random, slot)}}
	}
	step := crashStep{Op: "insert", Documents: map[string]map[string]any{}}
	for offset := 0; offset < slots && len(step.Documents) < crashInsertBatch; offset++ {
		candidate := (slot + offset) % slots
		if _, present := held[crashSlotID(candidate)]; !present {
			step.Documents[crashSlotID(candidate)] = crashDocument(random, candidate)
		}
	}
	return step
}

func applyCrashStep(ctx context.Context, narsil *engine.Narsil, step crashStep) error {
	switch step.Op {
	case "remove":
		return narsil.Remove(ctx, crashIndexName, step.ID, engine.WriteOptions{})
	case "update":
		return narsil.Update(ctx, crashIndexName, step.ID, engine.DocumentFromMap(step.Documents[step.ID]), engine.WriteOptions{})
	}
	batch := make([]*engine.Document, 0, len(step.Documents))
	for id, document := range step.Documents {
		fields := map[string]any{"id": id}
		for key, value := range document {
			fields[key] = value
		}
		batch = append(batch, engine.DocumentFromMap(fields))
	}
	result, err := narsil.InsertBatch(ctx, crashIndexName, batch, engine.InsertOptions{})
	if err != nil {
		return err
	}
	if len(result.Failed) > 0 {
		return result.Failed[0].Err
	}
	return nil
}
