package query

import "github.com/assetcorp/narsil/packages/go/engine/internal/core"

type phraseRows struct {
	phrase      int
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
				held = append(held, exists)
				postings := core.PhrasePostings{}
				if segment.Paged == nil {
					postings = segment.phrasePostings(term, exists)
				} else if postings, err = s.pagedPhrasePostings(segment, term, exists); err != nil {
					return nil, err
				}
				request.Postings = append(request.Postings, postings)
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
	if _, err := s.workspace.MatchPhrases(&request, s.work, &output); err != nil {
		return nil, err
	}
	matches := &phraseMatches{matched: output.Matched}
	for phrase := range query.Phrases {
		complete := true
		for entry := request.Starts[phrase]; entry < request.Starts[phrase+1]; entry++ {
			if !held[request.Tokens[entry]] {
				complete = false
				break
			}
		}
		if !complete {
			continue
		}
		from, to := output.Starts[phrase], output.Starts[phrase+1]
		matches.rows = append(matches.rows, phraseRows{
			phrase:      phrase,
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
