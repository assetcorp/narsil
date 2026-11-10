package index

import (
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partition"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/projection"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type AggregateStats struct {
	TotalDocuments    int
	DocFrequencies    map[string]int
	TotalFieldLengths map[string]float64
}

func (ix *Index) ReadPartitions(visit func(views []partition.View) error) error {
	held := ix.acquireAll(ix.allPartitionIDs())
	defer held.release()
	return visit(held.partitions)
}

func (ix *Index) ReadPartition(partitionID int, visit func(view partition.View) error) error {
	if partitionID < 0 || partitionID >= len(ix.partitions) {
		return narsilerr.New(narsilerr.CodeConfigInvalid,
			"Partition "+strconv.Itoa(partitionID)+" does not exist in an index of "+strconv.Itoa(len(ix.partitions))+" partitions",
			map[string]any{"partitionId": partitionID, "partitionCount": len(ix.partitions)})
	}
	view, release := ix.partitions[partitionID].Acquire()
	defer release()
	return visit(view)
}

func (ix *Index) RoutePartition(id string) int {
	return ix.partitionOf(id)
}

func (ix *Index) PartitionDocumentCount(partitionID int) int {
	if partitionID < 0 || partitionID >= len(ix.partitions) {
		return 0
	}
	count := 0
	ix.partitions[partitionID].Read(func(view partition.View) { count = view.Count() })
	return count
}

func (ix *Index) GetProjected(id string, requested model.DocumentProjection) (model.Document, bool) {
	stored, found := ix.Get(id)
	if !found {
		return nil, false
	}
	shown := projection.Resolve(requested)
	if shown.Kind() == model.ProjectNoFields {
		return model.Document{}, true
	}
	return shown.Clone(stored.Fields), true
}

func (ix *Index) MatchingDocumentIDs(expression *model.FilterExpression) ([]string, error) {
	filter, err := ix.compileFilter(expression, partition.NewWorkMeter(ix.settings.SearchWorkCap))
	if err != nil {
		return nil, err
	}
	var matched []string
	err = ix.ReadPartitions(func(views []partition.View) error {
		for _, view := range views {
			if filter == nil {
				view.ForEachDocument(func(_ uint32, document *partition.StoredDocument) bool {
					matched = append(matched, document.ID)
					return true
				})
				continue
			}
			ids, err := filter.matchingIDs(view)
			if err != nil {
				return err
			}
			matched = append(matched, ids...)
		}
		return nil
	})
	return matched, err
}

func (ix *Index) AggregateStats() AggregateStats {
	stats := AggregateStats{DocFrequencies: map[string]int{}, TotalFieldLengths: map[string]float64{}}
	_ = ix.ReadPartitions(func(views []partition.View) error {
		for _, view := range views {
			stats.TotalDocuments += view.TotalDocuments()
			for token, frequency := range view.DocumentFrequencies() {
				stats.DocFrequencies[token] += int(frequency)
			}
			for field, length := range view.TotalFieldLengths() {
				stats.TotalFieldLengths[field] += length
			}
		}
		return nil
	})
	return stats
}
