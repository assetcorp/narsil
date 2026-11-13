package engine

import (
	"context"
	"sync"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/analysis"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist"
)

func (n *Narsil) takeSideBuildTurn() (func(), error) {
	select {
	case n.sideBuildTurn <- struct{}{}:
	case <-n.stopping.Done():
		return nil, engineShutDown()
	}
	var once sync.Once
	return func() { once.Do(func() { <-n.sideBuildTurn }) }, nil
}

func (entry *indexEntry) settingsFor(analyzer *analysis.Analyzer, partitions int) index.Settings {
	settings := entry.swap.base
	settings.Analyzer = analyzer
	settings.PartitionCount = partitions
	return settings
}

func detachedBuilder(settings index.Settings, built *index.Index) func() (*index.Index, error) {
	settings.PartitionCount = 1
	settings.Slots = nil
	settings.Vectors = nil
	return func() (*index.Index, error) {
		current := settings
		current.Synonyms = built.Synonyms()
		current.BM25 = built.BM25()
		return index.New(current)
	}
}

func sortedIDsOf(ctx context.Context, source *index.Index, partitionID int) ([]string, error) {
	reading, err := source.Read(ctx)
	if err != nil {
		return nil, err
	}
	defer reading.Release()
	return reading.Snapshots[partitionID].SortedIDs()
}

func engineShutDown() error {
	return narsilerr.New(narsilerr.CodeInstanceShutDown, "This Narsil instance has been shut down", nil)
}

func storedWrite(ctx context.Context, source *index.Index, id string) (persist.Write, bool, error) {
	stored, found, err := source.Get(ctx, id)
	if err != nil || !found {
		return persist.Write{DocumentID: id}, false, err
	}
	if err := codec.DocumentFailure(stored.Document); err != nil {
		return persist.Write{}, false, err
	}
	encoded, err := codec.EncodeDocument(stored.Document)
	if err != nil {
		return persist.Write{}, false, err
	}
	return persist.Write{DocumentID: id, Document: stored.Document.Map(), Encoded: encoded}, true, nil
}

func copyChunk(ctx context.Context, handle *persist.Handle, source *index.Index, target *index.Index,
	ids []string) error {
	writes := make([]persist.Write, 0, len(ids))
	for _, id := range ids {
		write, found, err := storedWrite(ctx, source, id)
		if err != nil {
			return err
		}
		if !found {
			continue
		}
		writes = append(writes, write)
	}
	failures, err := handle.ApplyTo(ctx, target, writes, false)
	if err != nil {
		return err
	}
	for _, failure := range failures {
		if failure != nil {
			return failure
		}
	}
	return nil
}

func copyDocuments(ctx context.Context, handle *persist.Handle, source *index.Index, target *index.Index,
	proceed func() error, onPartition func(int)) error {
	for partitionID := range source.PartitionCount() {
		ids, err := sortedIDsOf(ctx, source, partitionID)
		if err != nil {
			return err
		}
		for start := 0; start < len(ids); start += rebuildChunkDocuments {
			if err := proceed(); err != nil {
				return err
			}
			if err := copyChunk(ctx, handle, source, target, ids[start:min(start+rebuildChunkDocuments, len(ids))]); err != nil {
				return err
			}
		}
		onPartition(partitionID + 1)
	}
	return proceed()
}

func (entry *indexEntry) beginRebuildLog() {
	entry.lockWrites()
	defer entry.writeMu.Unlock()
	entry.swap.mu.Lock()
	defer entry.swap.mu.Unlock()
	entry.swap.log = &rebuildLog{ids: map[string]struct{}{}}
}

func (entry *indexEntry) endRebuildLog() {
	entry.swap.mu.Lock()
	defer entry.swap.mu.Unlock()
	entry.swap.log = nil
}

func (entry *indexEntry) takeLogged() ([]string, bool) {
	entry.swap.mu.Lock()
	defer entry.swap.mu.Unlock()
	log := entry.swap.log
	if log == nil {
		return nil, false
	}
	ids := make([]string, 0, len(log.ids))
	for id := range log.ids {
		ids = append(ids, id)
	}
	cleared := log.cleared
	entry.swap.log = &rebuildLog{ids: map[string]struct{}{}}
	return ids, cleared
}

func (entry *indexEntry) loggedCount() int {
	entry.swap.mu.Lock()
	defer entry.swap.mu.Unlock()
	if entry.swap.log == nil {
		return 0
	}
	return len(entry.swap.log.ids)
}

func (entry *indexEntry) catchUpLocked(ctx context.Context, side *index.Index) error {
	ids, cleared := entry.takeLogged()
	if cleared {
		if err := side.Clear(nil); err != nil {
			return err
		}
	}
	if len(ids) == 0 {
		return nil
	}
	live := entry.index()
	writes := make([]persist.Write, len(ids))
	for at, id := range ids {
		write, _, err := storedWrite(ctx, live, id)
		if err != nil {
			return err
		}
		writes[at] = write
	}
	failures, err := entry.handle.ApplyTo(ctx, side, writes, false)
	if err != nil {
		return err
	}
	for at, failure := range failures {
		if failure != nil && writes[at].Document != nil {
			return failure
		}
	}
	return nil
}

func (entry *indexEntry) catchUp(ctx context.Context, side *index.Index, proceed func() error) error {
	for entry.loggedCount() > rebuildSwitchBacklogDocuments {
		if err := proceed(); err != nil {
			return err
		}
		entry.lockWrites()
		err := entry.catchUpLocked(ctx, side)
		entry.writeMu.Unlock()
		if err != nil {
			return err
		}
	}
	return nil
}
