package query

import "github.com/assetcorp/narsil/packages/go/engine/internal/core"

type scoringStatistics struct {
	totalDocuments float64
	averages       []float64
	frequencies    map[string]float64
}

func (s *scoringStatistics) frequencyOf(token string, local float64) float64 {
	if frequency, found := s.frequencies[token]; found {
		return frequency
	}
	return local
}

func segmentAverages(view *View, segment *Segment, into []float64) []float64 {
	into = into[:0]
	documents := segment.liveDocuments()
	for field := range view.FieldNames {
		total, present := segment.fieldTotal(field)
		switch {
		case !present:
			into = append(into, absentFieldAverage)
		case documents > 0:
			into = append(into, total/documents)
		default:
			into = append(into, 0)
		}
	}
	return into
}

func namedAverages(names []string, averages map[string]float64, into []float64) []float64 {
	into = into[:0]
	for _, name := range names {
		if average, found := averages[name]; found {
			into = append(into, average)
			continue
		}
		into = append(into, absentFieldAverage)
	}
	return into
}

func aggregateTotals(view *View) (float64, []float64, []bool) {
	documents := 0.0
	totals := make([]float64, len(view.FieldNames))
	present := make([]bool, len(view.FieldNames))
	for index := range view.Segments {
		segment := &view.Segments[index]
		documents += segment.liveDocuments()
		for field := range view.FieldNames {
			if total, held := segment.fieldTotal(field); held {
				totals[field] += total
				present[field] = true
			}
		}
	}
	return documents, totals, present
}

func aggregateAverages(view *View, into []float64) (float64, []float64) {
	documents, totals, present := aggregateTotals(view)
	into = into[:0]
	for field := range view.FieldNames {
		if !present[field] || documents <= 0 {
			into = append(into, absentFieldAverage)
			continue
		}
		into = append(into, totals[field]/documents)
	}
	return documents, into
}

func (s *searcher) partitionFrequency(view *View, token string) (float64, error) {
	total := 0.0
	for index := range view.Segments {
		frequency, err := s.segmentFrequency(&view.Segments[index], token)
		if err != nil {
			return 0, err
		}
		total += frequency
	}
	return total, nil
}

func (s *searcher) candidateTerms(view *View, query *KeywordQuery) ([]string, error) {
	seen := map[string]struct{}{}
	terms := []string{}
	add := func(token string) {
		if _, found := seen[token]; !found {
			seen[token] = struct{}{}
			terms = append(terms, token)
		}
	}
	for _, phrase := range query.Phrases {
		for _, token := range phrase.Tokens {
			add(token)
		}
	}
	for _, token := range query.Tokens {
		group := query.groupOf(token)
		if group != nil {
			for _, member := range group.Members {
				add(member.Token)
			}
			for _, synonym := range group.Synonyms {
				add(synonym)
			}
		}
		if group == nil && (query.Exact || query.Tolerance == 0) {
			add(token)
			continue
		}
		for index := range view.Segments {
			segment := &view.Segments[index]
			matches, err := s.typoMatches(segment, query, token, group)
			if err != nil {
				return nil, err
			}
			for _, term := range matches {
				add(segment.termText(term))
			}
		}
	}
	return terms, nil
}

func (s *searcher) compositeStatistics(view *View, query *KeywordQuery) (*scoringStatistics, error) {
	terms, err := s.candidateTerms(view, query)
	if err != nil {
		return nil, err
	}
	frequencies := make(map[string]float64, len(terms))
	for _, term := range terms {
		total, err := s.partitionFrequency(view, term)
		if err != nil {
			return nil, err
		}
		if total > 0 {
			frequencies[term] = total
		}
	}
	stats := &scoringStatistics{frequencies: frequencies}
	if query.Global == nil {
		stats.totalDocuments, stats.averages = aggregateAverages(view, s.averages)
		s.averages = stats.averages
		return stats, nil
	}
	for token, frequency := range query.Global.DocumentFrequencies {
		frequencies[token] = frequency
	}
	stats.totalDocuments = query.Global.TotalDocuments
	stats.averages = namedAverages(view.FieldNames, query.Global.AverageLengths, s.averages)
	s.averages = stats.averages
	return stats, nil
}

func (s *searcher) singleStatistics(view *View, segment *Segment, query *KeywordQuery) *scoringStatistics {
	if query.Global == nil {
		s.averages = segmentAverages(view, segment, s.averages)
		return &scoringStatistics{totalDocuments: segment.liveDocuments(), averages: s.averages}
	}
	s.averages = namedAverages(view.FieldNames, query.Global.AverageLengths, s.averages)
	return &scoringStatistics{
		totalDocuments: query.Global.TotalDocuments,
		averages:       s.averages,
		frequencies:    query.Global.DocumentFrequencies,
	}
}

func TypoTokens(views []*View, tokens []string, tolerance, prefixLength uint32) ([]string, error) {
	workspace, err := core.AcquireWorkspace()
	if err != nil {
		return nil, err
	}
	defer workspace.Release()
	s := &searcher{workspace: workspace}
	reached := []string{}
	seen := map[string]struct{}{}
	for _, view := range views {
		for _, token := range tokens {
			for index := range view.Segments {
				segment := &view.Segments[index]
				matches, err := s.finder.typo(workspace, segment, token, tolerance, prefixLength)
				if err != nil {
					return nil, err
				}
				for _, term := range matches {
					text := segment.termText(term)
					if _, found := seen[text]; !found {
						seen[text] = struct{}{}
						reached = append(reached, text)
					}
				}
			}
		}
	}
	return reached, nil
}

func CollectStatistics(views []*View, tokens []string) (*Statistics, error) {
	workspace, err := core.AcquireWorkspace()
	if err != nil {
		return nil, err
	}
	defer workspace.Release()
	s := &searcher{workspace: workspace}
	stats := &Statistics{
		FieldLengths:        map[string]float64{},
		AverageLengths:      map[string]float64{},
		DocumentFrequencies: map[string]float64{},
	}
	distinct := make([]string, 0, len(tokens))
	seen := make(map[string]struct{}, len(tokens))
	s.terms.reset()
	for _, token := range tokens {
		if _, repeated := seen[token]; !repeated {
			seen[token] = struct{}{}
			distinct = append(distinct, token)
			s.terms.add(token)
		}
	}
	for _, view := range views {
		documents, totals, present := aggregateTotals(view)
		stats.TotalDocuments += documents
		for field, name := range view.FieldNames {
			if present[field] {
				stats.FieldLengths[name] += totals[field]
			}
		}
		for _, token := range distinct {
			frequency, err := s.partitionFrequency(view, token)
			if err != nil {
				return nil, err
			}
			if frequency > 0 {
				stats.DocumentFrequencies[token] += frequency
			}
		}
	}
	if stats.TotalDocuments > 0 {
		for name, total := range stats.FieldLengths {
			stats.AverageLengths[name] = total / stats.TotalDocuments
		}
	}
	return stats, nil
}
