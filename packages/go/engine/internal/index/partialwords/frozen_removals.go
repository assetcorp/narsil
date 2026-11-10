package partialwords

import "bytes"

type FrozenRemovals struct {
	table   *FrozenTable
	tokenAt func(index int) string
	removed map[uint32]int
}

type RemovedSpellings struct {
	order     []string
	counts    map[string]int
	fallbacks map[string]unstemmedSpelling
}

type unstemmedSpelling struct {
	spelling string
	found    bool
}

func NewRemovedSpellings() *RemovedSpellings {
	return &RemovedSpellings{counts: map[string]int{}}
}

func (r *RemovedSpellings) Add(spelling string) {
	if _, held := r.counts[spelling]; !held {
		r.order = append(r.order, spelling)
	}
	r.counts[spelling]++
}

func (r *RemovedSpellings) Len() int {
	return len(r.order)
}

func (r *RemovedSpellings) fallbackOf(spelling string, analysis *Analysis) (string, bool, error) {
	if known, cached := r.fallbacks[spelling]; cached {
		return known.spelling, known.found, nil
	}
	if analysis == nil || analysis.Pass == nil {
		return "", false, nil
	}
	fallback, found, err := analysis.unstemmedSpelling(spelling)
	if err != nil {
		return "", false, err
	}
	if r.fallbacks == nil {
		r.fallbacks = map[string]unstemmedSpelling{}
	}
	r.fallbacks[spelling] = unstemmedSpelling{spelling: fallback, found: found}
	return fallback, found, nil
}

func (r *RemovedSpellings) ResolveFallbacks(analysis *Analysis) error {
	for _, spelling := range r.order {
		if _, _, err := r.fallbackOf(spelling, analysis); err != nil {
			return err
		}
	}
	return nil
}

func NewFrozenRemovals(table *FrozenTable, tokenAt func(index int) string) *FrozenRemovals {
	return &FrozenRemovals{table: table, tokenAt: tokenAt, removed: map[uint32]int{}}
}

func (r *FrozenRemovals) Table() *FrozenTable {
	return r.table
}

func (r *FrozenRemovals) Clone() *FrozenRemovals {
	removed := make(map[uint32]int, len(r.removed))
	for entry, count := range r.removed {
		removed[entry] = count
	}
	return &FrozenRemovals{table: r.table, tokenAt: r.tokenAt, removed: removed}
}

func (r *FrozenRemovals) Bytes() int {
	if r.table == nil {
		return 0
	}
	return r.table.Bytes() + len(r.removed)*frozenRemovedEntryBytes
}

func (r *FrozenRemovals) Apply(removed *RemovedSpellings, analysis *Analysis) error {
	if r.table == nil || removed == nil {
		return nil
	}
	for _, spelling := range removed.order {
		entry := r.EntryOf(spelling)
		if entry < 0 {
			fallback, found, err := removed.fallbackOf(spelling, analysis)
			if err != nil {
				return err
			}
			if found {
				entry = r.EntryOf(fallback)
			}
		}
		if entry >= 0 {
			r.removed[uint32(entry)] += removed.counts[spelling]
		}
	}
	return nil
}

func (r *FrozenRemovals) exhausted(entry uint32) bool {
	return r.removed[entry] >= int(r.table.Counts[entry])
}

func (r *FrozenRemovals) entryBytes(entry uint32) []byte {
	return r.table.Text[r.table.Offsets[entry]:r.table.Offsets[entry+1]]
}

func (r *FrozenRemovals) EntryOf(spelling string) int {
	if r.table == nil {
		return -1
	}
	written := newProbe(spelling)
	if len(written.points) <= runCodePoints {
		return -1
	}
	run := r.table.narrowestRun(written.points)
	if run < 0 {
		return -1
	}
	wanted := []byte(written.text)
	exhausted := -1
	for member := r.table.RunOffsets[run]; member < r.table.RunOffsets[run+1]; member++ {
		entry := r.table.RunEntries[member]
		if !bytes.Equal(r.entryBytes(entry), wanted) {
			continue
		}
		if !r.exhausted(entry) {
			return int(entry)
		}
		if exhausted < 0 {
			exhausted = int(entry)
		}
	}
	return exhausted
}

func (r *FrozenRemovals) forEachContaining(written probe, visit func(token string, spellingLength int)) {
	if r == nil || r.table == nil || len(written.points) < runCodePoints {
		return
	}
	run := r.table.narrowestRun(written.points)
	if run < 0 {
		return
	}
	wanted := []byte(written.text)
	for member := r.table.RunOffsets[run]; member < r.table.RunOffsets[run+1]; member++ {
		entry := r.table.RunEntries[member]
		spelling := r.entryBytes(entry)
		if len(spelling) <= len(wanted) || r.exhausted(entry) || !bytes.Contains(spelling, wanted) {
			continue
		}
		length := utf8CodePointCount(spelling)
		if length <= len(written.points) {
			continue
		}
		visit(r.tokenAt(int(r.table.Tokens[entry])), length)
	}
}
