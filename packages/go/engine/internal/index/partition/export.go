package partition

import (
	"sort"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/fieldindex"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/geo"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/postings"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type SurfaceForm struct {
	Surface     string
	Token       string
	Occurrences int
}

type FieldIndexes struct {
	Numbers    map[string]*fieldindex.Numeric
	Booleans   map[string]*fieldindex.Boolean
	Enums      map[string]*fieldindex.Enum
	Geopoints  map[string]*geo.Index
	ValueSizes map[string]*fieldindex.Numeric
}

func (v View) Postings() *postings.Index {
	return v.state.postings
}

func (v View) FieldNames() []string {
	return append([]string{}, v.state.fieldNames...)
}

func (v View) SurfaceForms() []SurfaceForm {
	forms := make([]SurfaceForm, 0, len(v.state.surfaces.entries))
	for surface, entry := range v.state.surfaces.entries {
		forms = append(forms, SurfaceForm{Surface: surface, Token: entry.token, Occurrences: entry.count})
	}
	sort.Slice(forms, func(left, right int) bool {
		return text.CompareCodePoints(forms[left].Surface, forms[right].Surface) < 0
	})
	return forms
}

func (v View) FieldIndexes() FieldIndexes {
	state := v.state
	return FieldIndexes{
		Numbers:    copyIndexes(state.numbers),
		Booleans:   copyIndexes(state.booleans),
		Enums:      copyIndexes(state.enums),
		Geopoints:  copyIndexes(state.geopoints),
		ValueSizes: copyIndexes(state.sizes),
	}
}

func (v View) AverageFieldLengths() map[string]float64 {
	if !v.HoldsFrozenSegments() {
		return v.state.statistics.averageFieldLengths()
	}
	documents, totals := aggregateFieldStats(v.sources())
	averages := make(map[string]float64, len(totals))
	if documents > 0 {
		for field, total := range totals {
			averages[field] = total / float64(documents)
		}
	}
	return averages
}

func (v View) DocumentFrequencies() map[string]uint32 {
	frequencies := make(map[string]uint32, v.state.postings.Size())
	v.state.postings.ForEachToken(func(token string) bool {
		frequencies[token] = v.state.postings.DocumentFrequency(token)
		return true
	})
	if v.tailOnly {
		return frequencies
	}
	for _, sub := range v.state.frozen {
		for at := 0; at < sub.segment.TokenCount(); at++ {
			if documents := sub.liveFrequencyAt(at); documents > 0 {
				frequencies[sub.segment.TokenAt(at)] += documents
			}
		}
	}
	return frequencies
}

func copyIndexes[V any](indexes map[string]V) map[string]V {
	copied := make(map[string]V, len(indexes))
	for path, index := range indexes {
		copied[path] = index
	}
	return copied
}
