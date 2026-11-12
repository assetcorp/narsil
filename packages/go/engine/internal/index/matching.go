package index

import (
	"context"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/query"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

func (ix *Index) ValidateFilter(expression *model.FilterExpression) error {
	return ix.validateFilter(expression)
}

func (ix *Index) MatchingIDs(ctx context.Context, expression *model.FilterExpression) (map[string]struct{}, error) {
	if err := ix.validateFilter(expression); err != nil {
		return nil, err
	}
	work := query.NewWork(ctx, ix.settings.SearchWorkCap)
	defer work.Close()
	prepared := &preparedQuery{params: model.QueryParams{Filters: expression}, work: work, ctx: ctx}
	if err := ix.openReads(prepared, nil); err != nil {
		return nil, err
	}
	defer prepared.reads.release()
	views, err := prepared.reads.views.all()
	if err != nil {
		return nil, err
	}
	matched := map[string]struct{}{}
	for at, snapshot := range prepared.reads.reading.Snapshots {
		set, _, err := listedSetOf(snapshot, views[at], prepared.filters, false)
		if err != nil {
			return nil, stoppedSearchFailure(ctx, err)
		}
		if !set.filtered {
			ids, err := snapshot.SortedIDs()
			if err != nil {
				return nil, err
			}
			for _, id := range ids {
				matched[id] = struct{}{}
			}
			continue
		}
		for id := range set.accepted {
			matched[id] = struct{}{}
		}
	}
	return matched, nil
}
