package growing

import "github.com/assetcorp/narsil/packages/go/engine/internal/core"

type surfaceTable struct {
	strings *stringTable
	token   column[uint32]
	count   column[uint32]
}

func newSurfaceTable() (*surfaceTable, error) {
	strings, err := newStringTable(surfaceTableStartCapacity)
	if err != nil {
		return nil, err
	}
	table := &surfaceTable{strings: strings}
	if err := table.resizeEntries(surfaceTableStartCapacity); err != nil {
		table.release()
		return nil, err
	}
	return table, nil
}

func (t *surfaceTable) resizeEntries(capacity uint64) error {
	if err := t.token.resize(capacity); err != nil {
		return err
	}
	return t.count.resize(capacity)
}

func (t *surfaceTable) reserve(entries, units uint64, extra *column[uint32]) error {
	plan, err := t.strings.prepareCapacity(entries, units)
	if err != nil {
		return err
	}
	if plan.offsets > t.token.len() {
		if err := t.resizeEntries(plan.offsets); err != nil {
			return err
		}
		if extra != nil {
			if err := extra.resize(plan.offsets); err != nil {
				return err
			}
		}
	}
	return t.strings.apply(plan)
}

func (t *surfaceTable) trim(extra *column[uint32]) error {
	count := min(t.token.len(), max(surfaceTableStartCapacity, t.strings.count()))
	if err := t.resizeEntries(count); err != nil {
		return err
	}
	if err := t.strings.trim(surfaceTableStartCapacity); err != nil {
		return err
	}
	if extra != nil {
		return extra.resize(min(extra.len(), t.count.len()))
	}
	return nil
}

func (t *surfaceTable) sparse() bool {
	live := t.strings.live()
	dead := t.strings.count() - min(t.strings.count(), live)
	return dead >= termVacuumMinDeadTerms && dead > live
}

func (t *surfaceTable) view() core.SurfaceTable {
	return core.SurfaceTable{Strings: t.strings.view(), Token: t.token.values, Count: t.count.values}
}

func (t *surfaceTable) bytes() uint64 {
	return t.strings.bytes() + t.token.bytes() + t.count.bytes()
}

func (t *surfaceTable) release() {
	t.strings.release()
	t.token.release()
	t.count.release()
}

type spellingTable struct {
	surfaceTable
	codePoints column[uint32]
	runs       *runTable
}

func newSpellingTable() (*spellingTable, error) {
	entries, err := newSurfaceTable()
	if err != nil {
		return nil, err
	}
	table := &spellingTable{surfaceTable: *entries}
	if err := table.codePoints.resize(surfaceTableStartCapacity); err != nil {
		table.release()
		return nil, err
	}
	runs, err := newRunTable()
	if err != nil {
		table.release()
		return nil, err
	}
	table.runs = runs
	return table, nil
}

func (t *spellingTable) view() *core.SpellingTable {
	return &core.SpellingTable{Entries: t.surfaceTable.view(), CodePoints: t.codePoints.values, Runs: t.runs.view()}
}

func (t *spellingTable) trim() error {
	if err := t.surfaceTable.trim(&t.codePoints); err != nil {
		return err
	}
	return t.runs.trim()
}

func (t *spellingTable) bytes() uint64 {
	total := t.surfaceTable.bytes() + t.codePoints.bytes()
	if t.runs != nil {
		total += t.runs.bytes()
	}
	return total
}

func (t *spellingTable) release() {
	t.surfaceTable.release()
	t.codePoints.release()
	if t.runs != nil {
		t.runs.release()
	}
}
