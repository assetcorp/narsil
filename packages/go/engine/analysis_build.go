package engine

import (
	"sync"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/analysis"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partition"
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
	return func() (*index.Index, error) {
		current := settings
		current.Synonyms = built.Synonyms()
		current.BM25 = built.BM25()
		return index.New(current)
	}
}

func sortedIDsOf(source *index.Index, partitionID int) ([]string, error) {
	var ids []string
	err := source.ReadPartition(partitionID, func(view partition.View) error {
		ids = view.SortedDocumentIDs()
		return nil
	})
	return ids, err
}

func engineShutDown() error {
	return narsilerr.New(narsilerr.CodeInstanceShutDown, "This Narsil instance has been shut down", nil)
}

func copyChunk(handle *persist.Handle, source *index.Index, target *index.Index, ids []string) error {
	writes := make([]persist.Write, 0, len(ids))
	for _, id := range ids {
		stored, found := source.Get(id)
		if !found {
			continue
		}
		writes = append(writes, persist.Write{DocumentID: id, Document: stored.Fields})
	}
	for _, err := range handle.ApplyTo(target, writes, false) {
		if err != nil {
			return err
		}
	}
	return nil
}

func copyDocuments(handle *persist.Handle, source *index.Index, target *index.Index, proceed func() error,
	onPartition func(int)) error {
	for partitionID := range source.PartitionCount() {
		ids, err := sortedIDsOf(source, partitionID)
		if err != nil {
			return err
		}
		for start := 0; start < len(ids); start += rebuildChunkDocuments {
			if err := proceed(); err != nil {
				return err
			}
			if err := copyChunk(handle, source, target, ids[start:min(start+rebuildChunkDocuments, len(ids))]); err != nil {
				return err
			}
		}
		onPartition(partitionID + 1)
	}
	return proceed()
}

func (entry *indexEntry) beginRebuildLog() {
	entry.writeMu.Lock()
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

func (entry *indexEntry) catchUpLocked(side *index.Index) error {
	ids, cleared := entry.takeLogged()
	if cleared {
		side.Clear()
	}
	if len(ids) == 0 {
		return nil
	}
	live := entry.index()
	writes := make([]persist.Write, len(ids))
	for at, id := range ids {
		writes[at] = persist.Write{DocumentID: id}
		if stored, found := live.Get(id); found {
			writes[at].Document = stored.Fields
		}
	}
	for at, err := range entry.handle.ApplyTo(side, writes, false) {
		if err != nil && writes[at].Document != nil {
			return err
		}
	}
	return nil
}

func (entry *indexEntry) catchUp(side *index.Index, proceed func() error) error {
	for entry.loggedCount() > rebuildSwitchBacklogDocuments {
		if err := proceed(); err != nil {
			return err
		}
		entry.writeMu.Lock()
		err := entry.catchUpLocked(side)
		entry.writeMu.Unlock()
		if err != nil {
			return err
		}
	}
	return nil
}
