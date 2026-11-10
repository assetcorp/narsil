package index

import (
	"strconv"
	"sync/atomic"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/analysis"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partition"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/synonyms"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

type Settings struct {
	Name            string
	Schema          *schema.Parsed
	PartitionCount  int
	Analyzer        *analysis.Analyzer
	Synonyms        *synonyms.Lookup
	BM25            *model.BM25Params
	DefaultScoring  model.ScoringMode
	TrackPositions  bool
	CollectSurfaces bool
	Strict          bool
	SearchWorkCap   int64
	Vectors         VectorFields
}

type Index struct {
	settings   Settings
	partitions []*partition.Partition
	synonyms   atomic.Pointer[synonyms.Lookup]
	bm25       atomic.Pointer[model.BM25Params]
}

func (ix *Index) Synonyms() *synonyms.Lookup {
	return ix.synonyms.Load()
}

func (ix *Index) SetSynonyms(lookup *synonyms.Lookup) {
	ix.synonyms.Store(lookup)
}

func (ix *Index) BM25() *model.BM25Params {
	return ix.bm25.Load()
}

func (ix *Index) SetBM25(params *model.BM25Params) {
	ix.bm25.Store(params)
}

func New(settings Settings) (*Index, error) {
	if settings.Schema == nil || settings.Analyzer == nil {
		return nil, narsilerr.New(narsilerr.CodeConfigInvalid, "An index needs a parsed schema and an analyser", nil)
	}
	if settings.PartitionCount <= 0 {
		return nil, narsilerr.New(narsilerr.CodeIndexNotFound,
			"Partition count must be greater than 0, received "+strconv.Itoa(settings.PartitionCount),
			map[string]any{"partitionCount": settings.PartitionCount})
	}
	if err := schema.RequireSurfaceFormsForPartialFields(settings.Schema, model.Some(settings.CollectSurfaces)); err != nil {
		return nil, err
	}
	if settings.SearchWorkCap <= 0 {
		settings.SearchWorkCap = DefaultSearchWorkCap
	}
	fields := settings.Schema.Fields()
	index := &Index{settings: settings, partitions: make([]*partition.Partition, settings.PartitionCount)}
	for id := range index.partitions {
		index.partitions[id] = partition.New(partition.Settings{
			ID:              id,
			Fields:          fields,
			PartialFields:   settings.Schema.PartialFields(),
			Analyzer:        settings.Analyzer,
			CollectSurfaces: settings.CollectSurfaces,
			TrackPositions:  settings.TrackPositions,
		})
	}
	index.synonyms.Store(settings.Synonyms)
	index.bm25.Store(settings.BM25)
	return index, nil
}

func (ix *Index) PartitionCount() int {
	return len(ix.partitions)
}

func (ix *Index) partitionOf(id string) int {
	return int(codec.FNV1aString(id) % uint32(len(ix.partitions)))
}

func (ix *Index) routed(ids []string) map[int][]int {
	groups := map[int][]int{}
	for at, id := range ids {
		target := ix.partitionOf(id)
		groups[target] = append(groups[target], at)
	}
	return groups
}

func (ix *Index) Insert(documents []partition.Document) []error {
	ids := make([]string, len(documents))
	for at, document := range documents {
		ids[at] = document.ID
	}
	failures := make([]error, len(documents))
	for target, members := range ix.routed(ids) {
		batch := make([]partition.Document, len(members))
		for at, member := range members {
			batch[at] = documents[member]
		}
		for at, err := range ix.partitions[target].Insert(batch) {
			failures[members[at]] = err
		}
	}
	return failures
}

func (ix *Index) Update(documents []partition.Document) []error {
	ids := make([]string, len(documents))
	for at, document := range documents {
		ids[at] = document.ID
	}
	failures := make([]error, len(documents))
	for target, members := range ix.routed(ids) {
		batch := make([]partition.Document, len(members))
		for at, member := range members {
			batch[at] = documents[member]
		}
		for at, err := range ix.partitions[target].Update(batch) {
			failures[members[at]] = err
		}
	}
	return failures
}

func (ix *Index) Remove(ids []string) []error {
	failures := make([]error, len(ids))
	for target, members := range ix.routed(ids) {
		batch := make([]string, len(members))
		for at, member := range members {
			batch[at] = ids[member]
		}
		for at, err := range ix.partitions[target].Remove(batch) {
			failures[members[at]] = err
		}
	}
	return failures
}

func (ix *Index) Clear() {
	for _, held := range ix.partitions {
		held.Clear()
	}
}

func (ix *Index) Get(id string) (*partition.StoredDocument, bool) {
	var found *partition.StoredDocument
	ix.partitions[ix.partitionOf(id)].Read(func(view partition.View) {
		found, _, _ = view.Document(id)
	})
	return found, found != nil
}

func (ix *Index) Has(id string) bool {
	_, found := ix.Get(id)
	return found
}

func (ix *Index) Count() int {
	total := 0
	for _, held := range ix.partitions {
		held.Read(func(view partition.View) { total += view.Count() })
	}
	return total
}

type views struct {
	partitions []partition.View
	releases   []func()
}

func (ix *Index) acquireAll(partitionIDs []int) views {
	held := views{}
	for _, id := range partitionIDs {
		view, release := ix.partitions[id].Acquire()
		held.partitions = append(held.partitions, view)
		held.releases = append(held.releases, release)
	}
	return held
}

func (v views) release() {
	for _, release := range v.releases {
		release()
	}
}

func (ix *Index) allPartitionIDs() []int {
	ids := make([]int, len(ix.partitions))
	for id := range ids {
		ids[id] = id
	}
	return ids
}
