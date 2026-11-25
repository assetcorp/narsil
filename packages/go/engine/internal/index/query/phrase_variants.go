package query

import (
	"slices"
	"strings"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
)

func (s *searcher) tokenPhrasePostings(segment *Segment, token string) (core.PhrasePostings, bool, error) {
	term, exists, err := s.exact(segment, token)
	if err != nil {
		return core.PhrasePostings{}, false, err
	}
	if segment.Paged == nil {
		return segment.phrasePostings(term, exists), exists, nil
	}
	postings, err := s.pagedPhrasePostings(segment, term, exists)
	return postings, exists, err
}

func phrasePositionKey(token string, variants []string) string {
	if len(variants) == 0 {
		return token
	}
	return strings.Join(append([]string{token}, variants...), "\x00")
}

func (s *searcher) positionPostings(segment *Segment, token string, variants []string) (core.PhrasePostings, bool, error) {
	postings, held, err := s.tokenPhrasePostings(segment, token)
	if err != nil || len(variants) == 0 {
		return postings, held, err
	}
	parts := []core.PhrasePostings{postings}
	for _, variant := range variants {
		found, exists, err := s.tokenPhrasePostings(segment, variant)
		if err != nil {
			return core.PhrasePostings{}, false, err
		}
		held = held || exists
		parts = append(parts, found)
	}
	return combinedPhrasePostings(parts), held, nil
}

func phraseRowOrder(part *core.PhrasePostings) []int {
	order := make([]int, len(part.Documents))
	for row := range order {
		order[row] = row
	}
	if !part.Ordered {
		slices.SortStableFunc(order, func(left, right int) int {
			return int(part.Documents[left]) - int(part.Documents[right])
		})
	}
	return order
}

func phraseRowPositions(part *core.PhrasePostings, row int) []uint32 {
	if row >= len(part.PositionStarts) || row >= len(part.PositionCounts) {
		return nil
	}
	start := uint64(part.PositionStarts[row])
	end := start + uint64(part.PositionCounts[row])
	if end > uint64(len(part.Positions)) {
		return nil
	}
	return part.Positions[start:end]
}

type phraseRowRef struct {
	part int
	row  int
}

func combinedPhrasePostings(parts []core.PhrasePostings) core.PhrasePostings {
	held := parts[:0:0]
	for _, part := range parts {
		if len(part.Documents) > 0 {
			held = append(held, part)
		}
	}
	if len(held) == 0 {
		return core.PhrasePostings{Ordered: true}
	}
	if len(held) == 1 {
		return held[0]
	}
	orders := make([][]int, len(held))
	for at := range held {
		orders[at] = phraseRowOrder(&held[at])
	}
	cursors := make([]int, len(held))
	merged := core.PhrasePostings{Ordered: true}
	var same []phraseRowRef
	for {
		lowest, found := uint32(0), false
		for at := range held {
			if cursors[at] < len(orders[at]) {
				document := held[at].Documents[orders[at][cursors[at]]]
				if !found || document < lowest {
					lowest, found = document, true
				}
			}
		}
		if !found {
			return merged
		}
		same = same[:0]
		for at := range held {
			for cursors[at] < len(orders[at]) && held[at].Documents[orders[at][cursors[at]]] == lowest {
				same = append(same, phraseRowRef{part: at, row: orders[at][cursors[at]]})
				cursors[at]++
			}
		}
		slices.SortStableFunc(same, func(left, right phraseRowRef) int {
			return int(held[left.part].Fields[left.row]) - int(held[right.part].Fields[right.row])
		})
		for first := 0; first < len(same); {
			field := held[same[first].part].Fields[same[first].row]
			start := len(merged.Positions)
			last := first
			for last < len(same) && held[same[last].part].Fields[same[last].row] == field {
				merged.Positions = append(merged.Positions, phraseRowPositions(&held[same[last].part], same[last].row)...)
				last++
			}
			if last-first > 1 {
				slices.Sort(merged.Positions[start:])
			}
			merged.Documents = append(merged.Documents, lowest)
			merged.Fields = append(merged.Fields, field)
			merged.PositionStarts = append(merged.PositionStarts, uint32(start))
			merged.PositionCounts = append(merged.PositionCounts, uint32(len(merged.Positions)-start))
			first = last
		}
	}
}
