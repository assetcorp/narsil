package engine

type copyHolds struct {
	logged func() uint64
	seen   uint64
	quiet  int
}

func steadyCopyHolds() *copyHolds {
	return &copyHolds{}
}

func copyHoldsBesideWritesOf(entry *indexEntry) *copyHolds {
	return &copyHolds{logged: entry.writesLogged, seen: entry.writesLogged(), quiet: rebuildCopyQuietHolds}
}

func (holds *copyHolds) next() int {
	if holds.logged == nil {
		return rebuildCopyHoldDocuments
	}
	if logged := holds.logged(); logged != holds.seen {
		holds.seen, holds.quiet = logged, 0
		return rebuildCopyHoldDocumentsBesideWrites
	}
	if holds.quiet < rebuildCopyQuietHolds {
		holds.quiet++
		return rebuildCopyHoldDocumentsBesideWrites
	}
	return rebuildCopyHoldDocuments
}

func (entry *indexEntry) writesLogged() uint64 {
	entry.swap.mu.Lock()
	defer entry.swap.mu.Unlock()
	return entry.swap.logged
}
