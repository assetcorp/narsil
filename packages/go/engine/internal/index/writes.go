package index

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partition"
	"github.com/assetcorp/narsil/packages/go/engine/internal/vector"
)

type PreparedDocument struct {
	partition int
	prepared  partition.Prepared
}

func (p PreparedDocument) ID() string {
	return p.prepared.ID
}

func (p PreparedDocument) Partition() int {
	return p.partition
}

type Write struct {
	ix    *Index
	write *partition.Write
}

func (w *Write) Sequence() int64 {
	return w.write.Sequence
}

func (ix *Index) prepare(documents []DocumentWrite) ([]PreparedDocument, []error) {
	prepared := make([]PreparedDocument, len(documents))
	failures := make([]error, len(documents))
	for at, document := range documents {
		values := document.ordered()
		if err := codec.DocumentFailure(values); err != nil {
			failures[at] = err
			continue
		}
		encoded, err := codec.EncodeDocument(values)
		if err != nil {
			failures[at] = err
			continue
		}
		target := ix.partitionOf(document.ID)
		analysed, err := ix.partitions[target].Prepare(document.ID, values, encoded)
		if err != nil {
			failures[at] = err
			continue
		}
		prepared[at] = PreparedDocument{partition: target, prepared: analysed}
	}
	return prepared, failures
}

func (ix *Index) Write(apply func(w *Write) error) error {
	return ix.sides.Write(func(write *partition.Write) error {
		return apply(&Write{ix: ix, write: write})
	})
}

type partitionWrite[T any] func(partition *partition.Partition, write *partition.Write, batch []T) ([]error, error)

func writeRouted[T any](w *Write, items []T, skip []error, partitionOf func(item T) int, apply partitionWrite[T]) ([]error, error) {
	failures := make([]error, len(items))
	copy(failures, skip)
	groups := map[int][]int{}
	for at, item := range items {
		if failures[at] == nil {
			target := partitionOf(item)
			groups[target] = append(groups[target], at)
		}
	}
	for target := range w.ix.partitions {
		members := groups[target]
		if len(members) == 0 {
			continue
		}
		batch := make([]T, len(members))
		for at, member := range members {
			batch[at] = items[member]
		}
		refused, err := apply(w.ix.partitions[target], w.write, batch)
		for at, failure := range refused {
			failures[members[at]] = failure
		}
		if err != nil {
			return failures, err
		}
	}
	return failures, nil
}

func preparedPartition(document PreparedDocument) int {
	return document.partition
}

func corePrepared(documents []PreparedDocument) []partition.Prepared {
	unwrapped := make([]partition.Prepared, len(documents))
	for at, document := range documents {
		unwrapped[at] = document.prepared
	}
	return unwrapped
}

func (w *Write) Insert(documents []PreparedDocument, refused []error) ([]error, error) {
	return writeRouted(w, documents, refused, preparedPartition,
		func(partition *partition.Partition, write *partition.Write, batch []PreparedDocument) ([]error, error) {
			return partition.Insert(write, corePrepared(batch))
		})
}

func (w *Write) Update(documents []PreparedDocument, refused []error) ([]error, error) {
	return writeRouted(w, documents, refused, preparedPartition,
		func(partition *partition.Partition, write *partition.Write, batch []PreparedDocument) ([]error, error) {
			return partition.Update(write, corePrepared(batch))
		})
}

func (w *Write) Remove(ids []string, refused []error) ([]error, error) {
	return writeRouted(w, ids, refused, w.ix.partitionOf,
		func(partition *partition.Partition, write *partition.Write, batch []string) ([]error, error) {
			return partition.Remove(write, batch)
		})
}

func (w *Write) Clear(vectors []vector.NamedField) error {
	if len(vectors) > 0 {
		var ids []string
		for _, held := range w.ix.partitions {
			ids = append(ids, held.Written(w.write).SortedIDs()...)
		}
		vector.ApplyDocumentsAt(w.Sequence(), vectors, vector.RemovalsOf(ids), make([]error, len(ids)))
	}
	for _, held := range w.ix.partitions {
		if err := held.Clear(w.write); err != nil {
			return err
		}
	}
	return nil
}

func (ix *Index) Clear(vectors []vector.NamedField) error {
	return ix.Write(func(w *Write) error { return w.Clear(vectors) })
}
