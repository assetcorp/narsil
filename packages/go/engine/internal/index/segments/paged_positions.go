package segments

import "github.com/assetcorp/narsil/packages/go/engine/internal/core"

func (p *Paged) readThroughCore(read func(w *core.Workspace, pages *core.PageCache) error) error {
	w, err := core.AcquireWorkspace()
	if err != nil {
		return err
	}
	defer w.Release()
	lease, err := pagedReadLeases.acquire()
	if err != nil {
		return err
	}
	defer pagedReadLeases.release(lease)
	return p.pageFailure(read(w, lease.pages))
}

func (p *Paged) ReadPositions(term uint32) ([]uint32, []uint32, bool, error) {
	span, held, err := p.reader.PositionSpan(int(term))
	if err != nil || !held {
		return nil, nil, false, err
	}
	list := core.PagedPositionList{Offsets: p.source.PageSection(span.Offsets), Values: p.source.PageSection(span.Values),
		First: span.FirstPosting, Count: span.PostingCount}
	valueCount := span.End - span.First
	output := core.PagedPositionOutput{Offsets: make([]uint32, uint64(span.PostingCount)+1),
		Values: make([]uint32, max(1, valueCount))}
	err = p.readThroughCore(func(w *core.Workspace, pages *core.PageCache) error {
		return w.ReadPagedPositions(pages, list, output)
	})
	if err != nil {
		return nil, nil, false, err
	}
	return output.Offsets, output.Values[:valueCount], true, nil
}
