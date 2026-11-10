package partialwords

import (
	"sort"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/postings"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type Reader interface {
	forEachContaining(written probe, visit func(token string, spellingLength int))
}

type Request struct {
	Written      string
	OwnToken     string
	Share        int
	Tolerance    int
	PrefixLength int
}

type AddedWord struct {
	Token  string
	Factor float64
}

type rankedWord struct {
	token          string
	documents      int
	spellingLength int
}

func excludedFromRequest(request Request, token string) bool {
	if token == request.OwnToken {
		return true
	}
	return request.Tolerance > 0 && postings.FuzzyTermMatches(request.OwnToken, token, request.Tolerance, request.PrefixLength)
}

func shortestSpellingsOf(readers []Reader, written probe) map[string]int {
	shortestSpelling := map[string]int{}
	for _, reader := range readers {
		reader.forEachContaining(written, func(token string, spellingLength int) {
			if known, found := shortestSpelling[token]; !found || spellingLength < known {
				shortestSpelling[token] = spellingLength
			}
		})
	}
	return shortestSpelling
}

func ShortestSpellings(readers []Reader, written string) map[string]int {
	return shortestSpellingsOf(readers, newProbe(written))
}

func addedWordsFor(readers []Reader, request Request, documentFrequency func(token string) int) []AddedWord {
	if request.Share <= 0 {
		return nil
	}
	written := newProbe(request.Written)
	shortestSpelling := shortestSpellingsOf(readers, written)
	ranked := make([]rankedWord, 0, len(shortestSpelling))
	for token, spellingLength := range shortestSpelling {
		if excludedFromRequest(request, token) {
			continue
		}
		if documents := documentFrequency(token); documents > 0 {
			ranked = append(ranked, rankedWord{token: token, documents: documents, spellingLength: spellingLength})
		}
	}
	sort.Slice(ranked, func(left, right int) bool {
		if ranked[left].documents != ranked[right].documents {
			return ranked[left].documents > ranked[right].documents
		}
		return text.CompareCodePoints(ranked[left].token, ranked[right].token) < 0
	})
	if len(ranked) > request.Share {
		ranked = ranked[:request.Share]
	}
	writtenLength := float64(len(written.points))
	added := make([]AddedWord, len(ranked))
	for at, word := range ranked {
		added[at] = AddedWord{Token: word.token, Factor: writtenLength / float64(word.spellingLength)}
	}
	return added
}

func Expand(readers []Reader, requests []Request, documentFrequency func(token string) int) [][]AddedWord {
	added := make([][]AddedWord, len(requests))
	if len(readers) == 0 {
		return added
	}
	for at, request := range requests {
		added[at] = addedWordsFor(readers, request, documentFrequency)
	}
	return added
}
