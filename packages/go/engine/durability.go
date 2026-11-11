package engine

import (
	"context"
	"fmt"
	"strings"
	"sync"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/metadata"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/checkpoint"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

type recoveringEntries struct {
	mu      sync.Mutex
	entries map[string]*indexEntry
}

func (recovering *recoveringEntries) put(entry *indexEntry) {
	recovering.mu.Lock()
	defer recovering.mu.Unlock()
	if earlier, found := recovering.entries[entry.name]; found {
		earlier.dispose()
	}
	recovering.entries[entry.name] = entry
}

func (recovering *recoveringEntries) take(name string) *indexEntry {
	recovering.mu.Lock()
	defer recovering.mu.Unlock()
	entry := recovering.entries[name]
	delete(recovering.entries, name)
	return entry
}

func (recovering *recoveringEntries) discard() {
	recovering.mu.Lock()
	defer recovering.mu.Unlock()
	for name, entry := range recovering.entries {
		entry.dispose()
		delete(recovering.entries, name)
	}
}

func configInvalid(message string) error {
	return narsilerr.New(narsilerr.CodeConfigInvalid, message, nil)
}

func durabilityDirectory(config model.Config) string {
	if config.Durability != nil && strings.TrimSpace(config.Durability.Directory) != "" {
		return config.Durability.Directory
	}
	if filesystem, backed := config.Persistence.(model.FilesystemPersistenceAdapter); backed {
		if directory := filesystem.Directory(); strings.TrimSpace(directory) != "" {
			return directory
		}
	}
	return ""
}

func validateDurability(durability *model.DurabilityConfig) error {
	if durability == nil {
		return nil
	}
	if durability.Tier != "" && durability.Tier != model.DurabilityWAL && durability.Tier != model.DurabilitySnapshot {
		return configInvalid(fmt.Sprintf("durability.tier must be \"wal\" or \"snapshot\", got %q", durability.Tier))
	}
	if durability.Mode != "" && durability.Mode != model.DurabilitySync && durability.Mode != model.DurabilityAsync {
		return configInvalid(fmt.Sprintf("durability.mode must be \"sync\" or \"async\", got %q", durability.Mode))
	}
	if threshold, set := durability.CheckpointMutationThreshold.Get(); set && threshold < 1 {
		return configInvalid(fmt.Sprintf("durability.checkpointMutationThreshold must be a finite number of at least 1, got %d", threshold))
	}
	if size, set := durability.SegmentMaxBytes.Get(); set && size < 1 {
		return configInvalid(fmt.Sprintf("durability.segmentMaxBytes must be a finite number of at least 1, got %d", size))
	}
	if threshold, set := durability.CompactionThreshold.Get(); set && threshold < 1 {
		return configInvalid(fmt.Sprintf("durability.compactionThreshold must be a finite number of at least 1, got %d", threshold))
	}
	if interval, set := durability.CheckpointInterval.Get(); set && interval < 0 {
		return configInvalid("durability.checkpointIntervalMs must be a finite number of at least 0")
	}
	if interval, set := durability.FlushInterval.Get(); set && interval < 0 {
		return configInvalid("durability.flushIntervalMs must be a finite number of at least 0")
	}
	if durability.Tier == model.DurabilitySnapshot && (durability.Directory != "" || durability.Mode != "" ||
		durability.FlushInterval.IsSet() || durability.SegmentMaxBytes.IsSet() || durability.CompactionThreshold.IsSet()) {
		return configInvalid("durability.directory, mode, flushIntervalMs, segmentMaxBytes, and compactionThreshold apply to the write-ahead log tier only and cannot combine with durability.tier \"snapshot\"")
	}
	return nil
}

func (n *Narsil) persistSettings() (persist.Settings, model.DurabilityTier, bool, error) {
	config := n.config
	if err := validateDurability(config.Durability); err != nil {
		return persist.Settings{}, "", false, err
	}
	durability := model.DurabilityConfig{}
	if config.Durability != nil {
		durability = *config.Durability
	}
	directory := durabilityDirectory(config)
	settings := persist.Settings{
		FlushInterval:               durability.FlushInterval.Or(0),
		CheckpointInterval:          durability.CheckpointInterval.Or(persist.DefaultCheckpointInterval),
		CheckpointMutationThreshold: int64(durability.CheckpointMutationThreshold.Or(0)),
		SegmentMaxBytes:             durability.SegmentMaxBytes.Or(0),
		CompactionThreshold:         durability.CompactionThreshold.Or(0),
		OnFatal: func(err error) {
			n.events.emit(model.DurabilityErrorEvent{Err: err})
		},
	}
	if durability.Mode == model.DurabilityAsync {
		settings.Mode = persist.ModeAsync
	}
	switch {
	case durability.Tier == model.DurabilitySnapshot:
		if config.Persistence == nil {
			return settings, "", false, configInvalid("Snapshot durability persists through a persistence adapter. Configure persistence, or remove durability.tier")
		}
		settings.Adapter = config.Persistence
		return settings, model.DurabilitySnapshot, true, nil
	case config.Durability != nil:
		if directory != "" {
			settings.Directory = directory
			return settings, model.DurabilityWAL, true, nil
		}
		if config.Persistence != nil {
			return settings, "", false, configInvalid("WAL durability requires a filesystem directory, but the configured persistence adapter is not filesystem-backed. Use a filesystem persistence adapter or set durability.directory")
		}
		return settings, "", false, configInvalid("Durability requires a directory. Set durability.directory explicitly, or configure a filesystem persistence adapter")
	case config.Persistence == nil:
		return settings, "", false, nil
	case directory != "":
		settings.Directory = directory
		return settings, model.DurabilityWAL, true, nil
	default:
		settings.Adapter = config.Persistence
		return settings, model.DurabilitySnapshot, true, nil
	}
}

func (n *Narsil) openDurability(ctx context.Context) error {
	settings, tier, enabled, err := n.persistSettings()
	if err != nil {
		return err
	}
	if !enabled {
		if n.config.Lifecycle != nil {
			return configInvalid("Index lifecycle settings require durability")
		}
		return nil
	}
	recovering := n.recovering
	hooks := persist.Hooks{
		CreateIndex: func(ctx context.Context, meta metadata.Metadata) (*persist.Handle, error) {
			entry, err := n.entryFromMetadata(ctx, meta)
			if err != nil {
				return nil, err
			}
			recovering.put(entry)
			return entry.handle, nil
		},
		OnLayoutUpgrade: func(event persist.LayoutUpgradeEvent) {
			n.events.emit(model.LayoutUpgradeEvent{IndexName: event.IndexName, Status: model.ProgressStatus(event.Status),
				Layout: model.EarlierLayout(event.Layout), Err: event.Err})
		},
	}
	manager, err := persist.Open(ctx, settings, hooks)
	if err != nil {
		return err
	}
	n.manager, n.tier = manager, tier
	if n.config.Lifecycle != nil {
		if err := n.registerClosedIndexes(ctx); err != nil {
			_ = manager.Close(context.WithoutCancel(ctx))
			n.manager = nil
			return err
		}
		return nil
	}
	recovered, err := manager.Recover(ctx)
	if err != nil {
		recovering.discard()
		_ = manager.Close(context.WithoutCancel(ctx))
		n.manager = nil
		return err
	}
	for _, durable := range recovered {
		entry := recovering.take(durable.Handle().Name)
		if entry == nil {
			continue
		}
		entry.durable = durable
		n.install(entry)
		n.resumeAnalysisWork(ctx, entry)
	}
	return nil
}

func (n *Narsil) recoveredGeneration(ctx context.Context, meta metadata.Metadata, stored *storedIndex) error {
	read, err := checkpoint.ReadManifest(ctx, n.manager.Store(), meta.IndexName)
	if err != nil || read.Kind != checkpoint.ManifestCurrent {
		return err
	}
	saved := read.Manifest.AnalysisGeneration
	current := meta.AnalysisGeneration.Or(0)
	if pending := meta.PendingAnalysis; pending != nil && saved == pending.Generation && saved != current {
		stored.analysis.generation = pending.Generation
		stored.analysis.language = pending.Language
		stored.config.Language = pending.Language
		stored.config.Tokenizer = model.TokenizerSetting{}
		stored.config.StopWords = model.StopWords{}
		if name, named := pending.Tokenizer.Get(); named {
			stored.config.Tokenizer = model.RegisteredTokenizer(name)
		}
		if name, named := pending.StopWords.Get(); named {
			stored.config.StopWords = model.RegisteredStopWords(name)
		} else if words, listed := pending.StopWordList.Get(); listed {
			stored.config.StopWords = model.StopWordList(words...)
		}
		return nil
	}
	if saved == current {
		return nil
	}
	return narsilerr.New(narsilerr.CodeConfigInvalid,
		fmt.Sprintf("Index %q holds terms of analysis generation %d, while its metadata records generation %d and no pending change of that generation",
			meta.IndexName, saved, current),
		map[string]any{"indexName": meta.IndexName, "analysisGeneration": saved, "metadataGeneration": current})
}

func (n *Narsil) entryFromMetadata(ctx context.Context, meta metadata.Metadata) (*indexEntry, error) {
	stored := storedFromMetadata(meta)
	if err := n.recoveredGeneration(ctx, meta, &stored); err != nil {
		return nil, err
	}
	entry, err := n.entryFromStored(meta.IndexName, stored)
	if err == nil {
		entry.noteRecovered(meta)
	}
	return entry, err
}

func (n *Narsil) entryFromStored(name string, stored storedIndex) (*indexEntry, error) {
	config := stored.config
	parsed, err := schema.Parse(config.Schema)
	if err != nil {
		return nil, err
	}
	parsed = parsed.InFieldOrder(stored.schemaOrder)
	embedder, embeddingName, err := n.resolveEmbedding(config, parsed, false)
	if err != nil {
		return nil, err
	}
	partitions := stored.partitions
	if partitions <= 0 {
		partitions = partitionCountOf(config)
	}
	analysis := stored.analysis
	entry, err := n.buildEntry(buildRequest{name: name, config: config, parsed: parsed, partitions: partitions,
		createdAt: stored.createdAt, stored: &analysis, embedder: embedder, embeddingName: embeddingName, sync: stored.sync})
	if err == nil {
		entry.suggestions.set(stored.suggestions)
	}
	return entry, err
}
