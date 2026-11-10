package partition

import (
	"sort"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/analysis"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/frozen"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partialwords"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/pattern"
)

func partialTextsOf(document map[string]any, fields []string) []string {
	var texts []string
	for _, field := range fields {
		if value, found := NestedValue(document, field); found {
			texts = append(texts, partialwords.TextsOf(value)...)
		}
	}
	return texts
}

func (p *Partition) partialAnalysis(pass *analysis.Pass) *partialwords.Analysis {
	return &partialwords.Analysis{Fields: p.settings.PartialFields, Analyzer: p.settings.Analyzer, Pass: pass}
}

func (p *Partition) removedSpellingsOf(segment *frozen.Segment, document *StoredDocument, pass *analysis.Pass) (*partialwords.RemovedSpellings, error) {
	if segment == nil || segment.PartialWords() == nil || len(p.settings.PartialFields) == 0 {
		return nil, nil
	}
	partial := p.partialAnalysis(pass)
	removed, err := partial.RemovedSpellingsOf(partialTextsOf(document.Fields, p.settings.PartialFields))
	if err != nil {
		return nil, err
	}
	return removed, removed.ResolveFallbacks(partial)
}

func (p *Partition) segmentTexts(segment *frozen.Segment) partialwords.DocumentTexts {
	return func(ordinal int) ([]string, error) {
		document, err := segment.DocumentAt(uint32(ordinal))
		if err != nil || document == nil {
			return nil, err
		}
		return partialTextsOf(document.Fields, p.settings.PartialFields), nil
	}
}

func (p *Partition) mergedSpellings(inputs []frozen.MergeInput, pass *analysis.Pass) (*partialwords.EncodedSpellings, error) {
	if len(p.settings.PartialFields) == 0 {
		return nil, nil
	}
	partial := p.partialAnalysis(pass)
	counts := partialwords.NewSpellingCounts()
	for at, merged := range frozen.MergeRemaps(inputs) {
		segment := inputs[at].Segment
		source := partialwords.MergeSource{Table: segment.PartialWords(), TokenAt: segment.TokenAt, Merged: merged, Texts: p.segmentTexts(segment)}
		if err := partial.CountKeptSpellings(counts, source); err != nil {
			return nil, err
		}
	}
	encoded := counts.Encode(p.settings.PartialFields)
	return &encoded, nil
}

func (p *Partition) withPartialTable(segment *frozen.Segment, tombstoned func(ordinal int) bool, pass *analysis.Pass) (*frozen.Segment, bool, error) {
	fields := p.settings.PartialFields
	if len(fields) == 0 {
		return segment, false, nil
	}
	if table := segment.PartialWords(); table != nil && partialwords.SameFields(table.Fields, fields) {
		return segment, false, nil
	}
	table, err := p.partialAnalysis(pass).RebuildFrozenTable(segment.DocumentCount(), tombstoned, p.segmentTexts(segment), segment.TokenIndex)
	if err != nil {
		return nil, false, err
	}
	return segment.WithPartialWords(table), true, nil
}

func (p *Partition) carriedText(segment *frozen.Segment, document *StoredDocument, analysed Analysis, removesSpellings bool) (analysedText, error) {
	text, err := analysed.removalText(document, p.fields)
	if err != nil || !removesSpellings {
		return text, err
	}
	text.removedSpellings, err = p.removedSpellingsOf(segment, document, analysed.Pass)
	return text, err
}

func (s *side) frozenPatterns(remap []int32) []pattern.Arrays {
	fields := make([]string, 0, len(s.patterns))
	for field := range s.patterns {
		fields = append(fields, field)
	}
	sort.Strings(fields)
	arrays := make([]pattern.Arrays, len(fields))
	for at, field := range fields {
		arrays[at] = s.patterns[field].RemappedArrays(field, remap)
	}
	return arrays
}

func (s *side) partialReaders(tailOnly bool) []partialwords.Reader {
	readers := make([]partialwords.Reader, 0, len(s.frozen)+1)
	if !tailOnly {
		for _, sub := range s.frozen {
			if sub.partial != nil {
				readers = append(readers, sub.partial)
			}
		}
	}
	if len(s.partial.Fields()) > 0 {
		readers = append(readers, s.partial)
	}
	return readers
}

func (v View) ExpandPartialWords(requests []partialwords.Request) [][]partialwords.AddedWord {
	documentFrequency := func(token string) int {
		total, _ := v.DocumentFrequency(token)
		return int(total)
	}
	return partialwords.Expand(v.state.partialReaders(v.tailOnly), requests, documentFrequency)
}
