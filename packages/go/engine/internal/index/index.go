package index

import (
	"strconv"
	"sync/atomic"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/analysis"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/fields"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partition"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/synonyms"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
	"github.com/assetcorp/narsil/packages/go/engine/internal/vector"
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
	Slots           *vector.Slots
	PatternLimit    uint32
}

type Index struct {
	settings   Settings
	slots      *vector.Slots
	sides      *partition.Sides
	kept       *partition.KeptColumns
	partitions []*partition.Partition
	synonyms   atomic.Pointer[synonyms.Lookup]
	bm25       atomic.Pointer[model.BM25Params]
}

type StoredDocument struct {
	ID       string
	Document *codec.Document
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

func (ix *Index) Slots() *vector.Slots {
	return ix.slots
}

func fieldLimits(patternLimit uint32) fields.Limits {
	limits := fields.DefaultLimits()
	if patternLimit > 0 {
		limits.PatternValueLimit = patternLimit
	}
	return limits
}

func partitionSettings(settings *Settings, kept *partition.KeptColumns, id int) partition.Settings {
	declared := settings.Schema.Fields()
	var text []schema.Field
	for _, field := range declared {
		if field.IsWordIndexed() {
			text = append(text, field)
		}
	}
	return partition.Settings{
		ID:              id,
		TextFields:      text,
		ValueFields:     declared,
		PartialFields:   settings.Schema.PartialFields(),
		Analyzer:        settings.Analyzer,
		CollectSurfaces: settings.CollectSurfaces,
		TrackPositions:  settings.TrackPositions,
		Limits:          fieldLimits(settings.PatternLimit),
		Kept:            kept,
	}
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
	ix := &Index{settings: settings, kept: &partition.KeptColumns{}}
	if settings.Slots != nil {
		ix.slots = settings.Slots.Retain()
	} else {
		slots, err := vector.NewSlots()
		if err != nil {
			return nil, err
		}
		ix.slots = slots
	}
	ix.sides = partition.NewSides(ix.slots)
	for id := range settings.PartitionCount {
		created, err := partition.New(partitionSettings(&settings, ix.kept, id))
		if err != nil {
			ix.Release()
			return nil, err
		}
		ix.partitions = append(ix.partitions, created)
		ix.sides.Add(created)
	}
	ix.synonyms.Store(settings.Synonyms)
	ix.bm25.Store(settings.BM25)
	return ix, nil
}

func (ix *Index) Release() {
	for _, held := range ix.partitions {
		held.Release()
	}
	ix.partitions = nil
	if ix.slots != nil {
		ix.slots.Close()
		ix.slots = nil
	}
}

func (ix *Index) PartitionCount() int {
	return len(ix.partitions)
}

func (ix *Index) partitionOf(id string) int {
	return int(codec.FNV1aString(id) % uint32(len(ix.partitions)))
}
