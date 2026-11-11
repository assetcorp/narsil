package segments

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

const pagedTermTotalBytes = 8

func (p *Paged) TermTotals() ([]float64, error) {
	if held := p.totals.Load(); held != nil {
		return *held, nil
	}
	count := len(p.Keyword.Segment.Terms.Counts)
	section, err := p.reader.Section("tokenTotals")
	if err != nil {
		return nil, err
	}
	if section.Length != int64(count)*pagedTermTotalBytes {
		return nil, narsilerr.New(narsilerr.CodePersistenceLoadFailed,
			`The term totals of "`+p.Path()+`" have the wrong length`, map[string]any{"path": p.Path()})
	}
	totals := make([]float64, count)
	if count > 0 {
		err = p.readThroughCore(func(w *core.Workspace, pages *core.PageCache) error {
			return w.ReadPagedTotals(pages, p.source.PageSection(section), core.PagedTotalsRequest{Count: uint32(count)}, totals)
		})
		if err != nil {
			return nil, err
		}
	}
	p.totals.CompareAndSwap(nil, &totals)
	return *p.totals.Load(), nil
}
