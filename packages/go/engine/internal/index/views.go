package index

import (
	"sync"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partition"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/query"
)

type partitionViews struct {
	once     sync.Once
	reading  *Reading
	requests []partition.ColumnRequest
	views    []*query.View
	err      error
}

func newPartitionViews(reading *Reading, requests []partition.ColumnRequest) *partitionViews {
	return &partitionViews{reading: reading, requests: requests}
}

func (p *partitionViews) build() {
	p.views = make([]*query.View, len(p.reading.Snapshots))
	for at, snapshot := range p.reading.Snapshots {
		view, err := snapshot.ViewWith(p.requests)
		if err != nil {
			p.err = err
			return
		}
		p.views[at] = view
	}
}

func (p *partitionViews) all() ([]*query.View, error) {
	p.once.Do(p.build)
	if p.err != nil {
		return nil, p.err
	}
	return p.views, nil
}

type queryReads struct {
	reading *Reading
	views   *partitionViews
	filters *filterRun
	release func()
}

func (ix *Index) openReads(prepared *preparedQuery, groupFields []string) error {
	reading, err := ix.Read(prepared.context())
	if err != nil {
		return err
	}
	filters, err := newFilterRun(prepared.params.Filters, prepared.work)
	if err != nil {
		reading.Release()
		return err
	}
	views := newPartitionViews(reading, ix.columnRequests(&prepared.params, groupFields))
	prepared.reads = &queryReads{reading: reading, views: views, filters: filters}
	prepared.filters = filters
	prepared.reads.release = func() {
		filters.release()
		reading.Release()
	}
	return nil
}
