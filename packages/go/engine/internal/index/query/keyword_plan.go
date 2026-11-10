package query

func (s *searcher) typoMatches(segment *Segment, query *KeywordQuery, token string, group *TermGroup) ([]uint32, error) {
	if group != nil {
		if !group.TypoMatches || query.Exact || query.Tolerance == 0 {
			return nil, nil
		}
		found, err := s.typo(segment, token, query.Tolerance, query.PrefixLength)
		if err != nil {
			return nil, err
		}
		kept := found[:0]
		for _, term := range found {
			matched := segment.termText(term)
			if matched != token && !group.holdsSynonym(matched) {
				kept = append(kept, term)
			}
		}
		return kept, nil
	}
	if !query.Exact {
		return s.typo(segment, token, query.Tolerance, query.PrefixLength)
	}
	return s.typo(segment, token, 0, 0)
}

func (s *searcher) planTerms(segment *Segment, query *KeywordQuery, stats *scoringStatistics) error {
	for term, token := range query.Tokens {
		group := query.groupOf(token)
		matches, err := s.typoMatches(segment, query, token, group)
		if err != nil {
			return err
		}
		s.builder.termSlot(term)
		for _, match := range matches {
			list, err := s.postingsOf(segment, match)
			if err != nil {
				return err
			}
			frequency := segment.liveFrequency(match)
			if len(stats.frequencies) > 0 {
				frequency = stats.frequencyOf(segment.termText(match), frequency)
			}
			s.builder.poolList(list, frequency, 0)
		}
		if group != nil {
			if err := s.planGroup(segment, query, stats, group, term); err != nil {
				return err
			}
		}
	}
	return nil
}

type plannedMember struct {
	member GroupMember
	list   postingList
	rows   *rowColumns
}

func (s *searcher) frequencyOf(segment *Segment, stats *scoringStatistics, token string) (float64, error) {
	if frequency, found := stats.frequencies[token]; found {
		return frequency, nil
	}
	return s.segmentFrequency(segment, token)
}

func (s *searcher) planGroup(segment *Segment, query *KeywordQuery, stats *scoringStatistics, group *TermGroup, term int) error {
	documentFrequency := 0.0
	for _, synonym := range group.Synonyms {
		frequency, err := s.frequencyOf(segment, stats, synonym)
		if err != nil {
			return err
		}
		documentFrequency = max(documentFrequency, frequency)
	}
	members := s.members[:0]
	for _, member := range group.Members {
		frequency, err := s.frequencyOf(segment, stats, member.Token)
		if err != nil {
			return err
		}
		documentFrequency = max(documentFrequency, frequency)
		if len(group.Synonyms) > 0 && member.Token == group.Token {
			planned, found, err := s.combinedMember(segment, member, group.Synonyms)
			if err != nil {
				return err
			}
			if found {
				members = append(members, planned)
			}
			continue
		}
		found, held, err := s.exact(segment, member.Token)
		if err != nil {
			return err
		}
		if held {
			list, err := s.postingsOf(segment, found)
			if err != nil {
				return err
			}
			members = append(members, plannedMember{member: member, list: list})
		}
	}
	s.members = members
	s.builder.groupSlot(term, documentFrequency)
	for _, planned := range members {
		if planned.rows != nil {
			s.builder.rowList(planned.rows, false, planned.member.Factor, planned.member.PartialFactor)
			continue
		}
		s.builder.poolList(planned.list, planned.member.Factor, planned.member.PartialFactor)
	}
	return nil
}

func (s *searcher) combinedMember(segment *Segment, member GroupMember, synonyms []string) (plannedMember, bool, error) {
	lists := s.combineLists[:0]
	for _, token := range append([]string{member.Token}, synonyms...) {
		term, found, err := s.exact(segment, token)
		if err != nil {
			return plannedMember{}, false, err
		}
		if found {
			list, err := s.postingsOf(segment, term)
			if err != nil {
				return plannedMember{}, false, err
			}
			lists = append(lists, list)
		}
	}
	s.combineLists = lists
	switch len(lists) {
	case 0:
		return plannedMember{}, false, nil
	case 1:
		return plannedMember{member: member, list: lists[0]}, true, nil
	}
	rows := s.combine(segment, lists)
	return plannedMember{member: member, rows: rows}, true, nil
}

func (s *searcher) planPhrases(segment *Segment, query *KeywordQuery, stats *scoringStatistics, matches *phraseMatches) error {
	for _, rows := range matches.rows {
		phrase := &query.Phrases[rows.phrase]
		frequencies := make([]float64, len(phrase.Tokens))
		for at, token := range phrase.Tokens {
			frequencies[at] = stats.frequencyOf(token, segment.liveFrequency(rows.terms[at]))
		}
		s.builder.phraseSlot(frequencies, rows.documents, rows.fields, rows.frequencies)
	}
	return nil
}
