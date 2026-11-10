package partialwords

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/analysis"
)

type Analysis struct {
	Fields   []string
	Analyzer *analysis.Analyzer
	Pass     *analysis.Pass
}

type DocumentTexts func(ordinal int) ([]string, error)

func (a *Analysis) CountDocument(counts *SpellingCounts, texts []string) error {
	for _, source := range texts {
		if err := a.Pass.Visit(source, analysis.SurfaceOptions, counts.CountToken); err != nil {
			return err
		}
	}
	return nil
}

func (a *Analysis) RemovedSpellingsOf(texts []string) (*RemovedSpellings, error) {
	removed := NewRemovedSpellings()
	if err := a.addRemovedSpellings(removed, texts); err != nil {
		return nil, err
	}
	return removed, nil
}

func (a *Analysis) addRemovedSpellings(removed *RemovedSpellings, texts []string) error {
	if a.Analyzer.HasCustomTokenizer() {
		for _, source := range texts {
			err := a.Pass.Visit(source, analysis.SurfaceOptions, func(token analysis.Token) { removed.Add(SpellingOf(token)) })
			if err != nil {
				return err
			}
		}
		return nil
	}
	analyser, err := core.AcquireAnalyser()
	if err != nil {
		return err
	}
	defer analyser.Release()
	for _, source := range texts {
		err := analyser.Analyse(a.Analyzer.Language(), core.AnalyseSpellings, source, nil, func(token core.Token) { removed.Add(token.Term) })
		if err != nil {
			return err
		}
	}
	return nil
}

func (a *Analysis) unstemmedSpelling(spelling string) (string, bool, error) {
	normalised, err := a.Pass.Transform(spelling, false, false)
	if err != nil || normalised == spelling {
		return "", false, err
	}
	kept := false
	err = a.Pass.VisitWithCore(spelling, analysis.Options{RemoveStopWords: true}, func(analysis.Token) { kept = true })
	if err != nil || !kept {
		return "", false, err
	}
	return normalised, true, nil
}

func (a *Analysis) RebuildFrozenTable(documentCount int, tombstoned func(ordinal int) bool, texts DocumentTexts, find func(token string) int) (*FrozenTable, error) {
	var uncounted []bool
	for ordinal := range documentCount {
		if !tombstoned(ordinal) {
			continue
		}
		if uncounted == nil {
			uncounted = make([]bool, documentCount)
		}
		uncounted[ordinal] = true
	}
	counts := NewSpellingCounts()
	for ordinal := range documentCount {
		if uncounted != nil && uncounted[ordinal] {
			continue
		}
		if err := a.countOrdinal(counts, texts, ordinal); err != nil {
			return nil, err
		}
	}
	table := BuildFrozenTable(counts.Encode(a.Fields), find)
	table.uncounted = uncounted
	return table, nil
}

func (a *Analysis) countOrdinal(counts *SpellingCounts, texts DocumentTexts, ordinal int) error {
	documentTexts, err := texts(ordinal)
	if err != nil {
		return err
	}
	return a.CountDocument(counts, documentTexts)
}
