package query

import "github.com/assetcorp/narsil/packages/go/engine/internal/core"

type phraseRows struct {
	phrase      int
	terms       []uint32
	documents   []uint32
	fields      []uint16
	frequencies []uint32
}

type phraseMatches struct {
	matched []uint32
	rows    []phraseRows
}

func (s *Segment) phrasePostings(term uint32, found bool) core.PhrasePostings {
	if !found {
		return core.PhrasePostings{Ordered: true}
	}
	list := s.postings(term)
	documents, _, fields := s.pool()
	end := list.start + list.length
	postings := core.PhrasePostings{
		Documents:      documents[list.start:end],
		Fields:         fields[list.start:end],
		PositionStarts: make([]uint32, list.length),
		PositionCounts: make([]uint32, list.length),
		Ordered:        list.ordered,
	}
	if s.Growing != nil {
		pool := s.Growing.Postings.PositionStarts
		store := s.Growing.Positions
		if store == nil || pool == nil || s.Growing.Columns.Flags[term]&growingTermPositions == 0 {
			return core.PhrasePostings{Ordered: true}
		}
		for row := range list.length {
			start := pool[list.start+row]
			postings.PositionStarts[row] = start + 1
			if int(start) < len(store.Values) {
				postings.PositionCounts[row] = store.Values[start]
			}
		}
		postings.Positions = store.Values
		return postings
	}
	offsets := s.Positions.Offsets
	if offsets == nil || s.Positions.Values == nil || int(end) >= len(offsets) {
		return core.PhrasePostings{Ordered: true}
	}
	for row := range list.length {
		at := list.start + row
		postings.PositionStarts[row] = offsets[at]
		postings.PositionCounts[row] = offsets[at+1] - offsets[at]
	}
	postings.Positions = s.Positions.Values
	return postings
}

func (s *searcher) matchPhrases(segment *Segment, query *KeywordQuery, searchable []uint8, filter []uint32, hasFilter bool) (*phraseMatches, error) {
	capacity := segment.capacity()
	request := core.PhraseRequest{
		Starts:       make([]uint32, len(query.Phrases)+1),
		Searchable:   searchable,
		HasFilter:    hasFilter,
		Filter:       filter,
		Removed:      segment.removed(),
		OrdinalCount: capacity,
		Collect:      true,
	}
	seen := map[string]uint32{}
	terms := []uint32{}
	held := []bool{}
	for phrase := range query.Phrases {
		request.Starts[phrase] = uint32(len(request.Tokens))
		analysed := &query.Phrases[phrase]
		for entry, token := range analysed.Tokens {
			at, found := seen[token]
			if !found {
				at = uint32(len(request.Postings))
				seen[token] = at
				term, exists, err := s.exact(segment, token)
				if err != nil {
					return nil, err
				}
				terms, held = append(terms, term), append(held, exists)
				request.Postings = append(request.Postings, segment.phrasePostings(term, exists))
			}
			request.Tokens = append(request.Tokens, at)
			request.Offsets = append(request.Offsets, analysed.Offsets[entry])
		}
	}
	request.Starts[len(query.Phrases)] = uint32(len(request.Tokens))
	rows := 0
	for phrase := range query.Phrases {
		least := -1
		for entry := request.Starts[phrase]; entry < request.Starts[phrase+1]; entry++ {
			count := len(request.Postings[request.Tokens[entry]].Documents)
			if least < 0 || count < least {
				least = count
			}
		}
		rows += max(0, least)
	}
	output := core.PhraseOutput{
		Matched:     make([]uint32, bitsetWords(capacity)),
		Starts:      make([]uint32, len(query.Phrases)+1),
		Documents:   make([]uint32, rows),
		Fields:      make([]uint16, rows),
		Frequencies: make([]uint32, rows),
	}
	if _, err := s.workspace.MatchPhrases(&request, s.meter(query), &output); err != nil {
		return nil, err
	}
	matches := &phraseMatches{matched: output.Matched}
	for phrase := range query.Phrases {
		phraseTerms := make([]uint32, 0, len(query.Phrases[phrase].Tokens))
		complete := true
		for entry := request.Starts[phrase]; entry < request.Starts[phrase+1]; entry++ {
			token := request.Tokens[entry]
			if !held[token] {
				complete = false
				break
			}
			phraseTerms = append(phraseTerms, terms[token])
		}
		if !complete {
			continue
		}
		from, to := output.Starts[phrase], output.Starts[phrase+1]
		matches.rows = append(matches.rows, phraseRows{
			phrase:      phrase,
			terms:       phraseTerms,
			documents:   output.Documents[from:to],
			fields:      output.Fields[from:to],
			frequencies: output.Frequencies[from:to],
		})
	}
	return matches, nil
}

func bitsetEmpty(bits []uint32) bool {
	for _, word := range bits {
		if word != 0 {
			return false
		}
	}
	return true
}
