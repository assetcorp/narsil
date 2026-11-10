package segment

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/frozen"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partition"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/postings"
)

type source struct {
	capacity          uint32
	documentAt        func(ordinal uint32) (*partition.StoredDocument, error)
	tokens            []string
	lookup            func(token string) (postings.List, bool, error)
	tracksPositions   bool
	totalFieldLengths map[string]float64
	indexes           partition.FieldIndexes
	surfaces          []partition.SurfaceForm
	fieldNames        []string
	pagedOrigin       bool
}

func tailSource(view partition.View) source {
	index := view.Postings()
	var tokens []string
	tracksPositions := false
	index.ForEachToken(func(token string) bool {
		tokens = append(tokens, token)
		if list, found := index.Lookup(token); found && list.HoldsPositions() {
			tracksPositions = true
		}
		return true
	})
	return source{
		capacity: view.Capacity(),
		documentAt: func(ordinal uint32) (*partition.StoredDocument, error) {
			if index.IsRetired(ordinal) {
				return nil, nil
			}
			return view.DocumentAtRead(ordinal)
		},
		tokens: tokens,
		lookup: func(token string) (postings.List, bool, error) {
			list, found := index.Lookup(token)
			return list, found, nil
		},
		tracksPositions:   tracksPositions,
		totalFieldLengths: view.TotalFieldLengths(),
		indexes:           view.FieldIndexes(),
		surfaces:          view.SurfaceForms(),
		fieldNames:        view.FieldNames(),
	}
}

func frozenSource(segment *frozen.Segment, tombstoned []uint32, liveSurfaces []frozen.SurfaceForm) source {
	dead := make(map[uint32]struct{}, len(tombstoned))
	for _, ordinal := range tombstoned {
		dead[ordinal] = struct{}{}
	}
	tokens := make([]string, segment.TokenCount())
	for at := range tokens {
		tokens[at] = segment.TokenAt(at)
	}
	held := segment.Indexes()
	surfaces := make([]partition.SurfaceForm, 0, len(liveSurfaces))
	for _, form := range liveSurfaces {
		surfaces = append(surfaces, partition.SurfaceForm{Surface: form.Surface, Token: form.Token,
			Occurrences: form.Occurrences})
	}
	return source{
		capacity: uint32(segment.DocumentCount()),
		documentAt: func(ordinal uint32) (*partition.StoredDocument, error) {
			if _, removed := dead[ordinal]; removed {
				return nil, nil
			}
			return segment.DocumentAt(ordinal)
		},
		tokens: tokens,
		lookup: func(token string) (postings.List, bool, error) {
			at, found := segment.FindToken(token)
			if !found {
				return postings.List{}, false, nil
			}
			list, err := segment.List(at, 0, 0)
			return list, err == nil, err
		},
		tracksPositions:   segment.TracksPositions(),
		totalFieldLengths: segment.TotalFieldLengths(),
		indexes: partition.FieldIndexes{Numbers: held.Numbers, Booleans: held.Booleans, Enums: held.Enums,
			Geopoints: held.Geopoints, ValueSizes: held.Sizes},
		surfaces:    surfaces,
		fieldNames:  segment.FieldNames(),
		pagedOrigin: segment.PagedOrigin(),
	}
}

func sourcesOf(view partition.View) []source {
	if !view.HoldsFrozenSegments() {
		return []source{tailSource(view)}
	}
	subs := view.Subs()
	sources := make([]source, 0, len(subs))
	for _, sub := range subs {
		if held := sub.Segment(); held != nil {
			sources = append(sources, frozenSource(held, sub.Tombstones(), sub.LiveSurfaces()))
			continue
		}
		sources = append(sources, tailSource(view.LiveTail()))
	}
	return sources
}
