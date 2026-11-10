package segment

import (
	"math"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/keyword"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partition"
)

type BuildOptions struct {
	Schema          map[string]string
	TargetBytes     int64
	Tombstones      []string
	KeepsEmpty      bool
	KeepsPagedWhole bool
}

func Build(view partition.View, options BuildOptions) ([]*keyword.Segment, error) {
	targetBytes := options.TargetBytes
	if targetBytes <= 0 {
		targetBytes = DefaultTargetSegmentBytes
	}
	segments := []*keyword.Segment{}
	sources := sourcesOf(view)
	for at, held := range sources {
		keepsEmpty := options.KeepsEmpty && at == len(sources)-1 && len(segments) == 0
		sourceTarget := targetBytes
		if options.KeepsPagedWhole && held.pagedOrigin {
			sourceTarget = math.MaxInt64
		}
		built, err := buildSource(held, options.Schema, sourceTarget, keepsEmpty)
		if err != nil {
			return nil, err
		}
		segments = append(segments, built...)
	}
	if len(segments) > 0 && len(options.Tombstones) > 0 {
		segments[0].Tombstones = append([]string{}, options.Tombstones...)
	}
	return segments, nil
}

func buildSource(held source, schema map[string]string, targetBytes int64, keepsEmpty bool) ([]*keyword.Segment,
	error) {
	plan, err := newLayout(held, targetBytes)
	if err != nil {
		return nil, err
	}
	if len(plan.chunks) == 1 && len(plan.chunks[0].ordinals) == 0 && !keepsEmpty {
		return nil, nil
	}
	if err := plan.postings(); err != nil {
		return nil, err
	}
	plan.fieldLengths()
	indexes := held.indexes
	plan.valueColumns(indexes.Numbers, func(current *chunk) *[]keyword.ValueColumn { return &current.numeric })
	plan.valueColumns(indexes.ValueSizes, func(current *chunk) *[]keyword.ValueColumn { return &current.sizes })
	plan.booleanColumns(indexes.Booleans)
	plan.enumColumns(indexes.Enums)
	plan.geopointColumns()
	surfaces := surfaceColumn(held.surfaces)
	segments := make([]*keyword.Segment, 0, len(plan.chunks))
	for at, current := range plan.chunks {
		segment := &keyword.Segment{
			Schema:              schema,
			Tombstones:          []string{},
			DocumentCount:       uint32(len(current.ordinals)),
			IDs:                 current.ids,
			IDOffsets:           current.idOffsets,
			IDOrder:             idOrder(current),
			Documents:           current.documents,
			DocumentOffsets:     current.documentOffsets,
			FieldNames:          held.fieldNames,
			Tokens:              current.tokens,
			TokenOffsets:        current.tokenOffsets,
			DocumentFrequencies: current.documentFrequencies,
			PostingOffsets:      current.postingOffsets,
			PostingDocuments:    current.postingDocuments,
			PostingFrequencies:  current.postingFrequencies,
			PostingFields:       current.postingFields,
			TracksPositions:     current.tracksPositions,
			PositionOffsets:     current.positionOffsets,
			Positions:           current.positions,
			FieldLengths:        current.fieldLengthColumns,
			Numeric:             current.numeric,
			Sizes:               current.sizes,
			Boolean:             current.boolean,
			Enum:                current.enum,
			Geopoint:            current.geopoint,
			Pattern:             []keyword.PatternColumn{},
		}
		if at == 0 {
			segment.SurfaceForms = surfaces
		}
		segments = append(segments, segment)
	}
	return segments, nil
}
