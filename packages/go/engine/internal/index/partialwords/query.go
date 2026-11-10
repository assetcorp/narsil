package partialwords

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type QueryToken struct {
	Token    string
	Position int
}

type Query struct {
	QueryTokens  []QueryToken
	Written      map[int]string
	PrefixToken  model.Optional[string]
	Tolerance    int
	PrefixLength model.Optional[int]
}

type TokenRequest struct {
	Token       string
	TypoMatches bool
	Request     Request
}

type TermAddition struct {
	Token       string
	TypoMatches bool
	Added       []AddedWord
}

type Member struct {
	Token         string
	Factor        float64
	PartialFactor float64
}

func isPrefixToken(query Query, token string) bool {
	prefix, set := query.PrefixToken.Get()
	return set && prefix == token
}

func Requests(query Query) []TokenRequest {
	type eligibleWord struct {
		token   string
		written string
	}
	var eligible []eligibleWord
	for _, queryToken := range query.QueryTokens {
		word, found := query.Written[queryToken.Position]
		if !found || !text.ExceedsCodePoints(word, minWrittenWordCodePoints-1) {
			continue
		}
		eligible = append(eligible, eligibleWord{token: queryToken.Token, written: word})
		if len(eligible) == maxAddedWordsPerQuery {
			break
		}
	}
	count := len(eligible)
	if count == 0 {
		return nil
	}
	evenShare := maxAddedWordsPerQuery / count
	remainder := maxAddedWordsPerQuery % count
	prefixLength := query.PrefixLength.Or(defaultFuzzyPrefixLength)
	requests := make([]TokenRequest, count)
	for order, entry := range eligible {
		share := evenShare
		if order < remainder {
			share++
		}
		prefix := isPrefixToken(query, entry.token)
		tolerance := query.Tolerance
		if prefix {
			tolerance = 0
		}
		requests[order] = TokenRequest{
			Token:       entry.token,
			TypoMatches: !prefix,
			Request:     Request{Written: entry.written, OwnToken: entry.token, Share: share, Tolerance: tolerance, PrefixLength: prefixLength},
		}
	}
	return requests
}

func ExpandQuery(query Query, expand func(requests []Request) [][]AddedWord) []TermAddition {
	tokenRequests := Requests(query)
	if len(tokenRequests) == 0 {
		return nil
	}
	requests := make([]Request, len(tokenRequests))
	for at, entry := range tokenRequests {
		requests[at] = entry.Request
	}
	added := expand(requests)
	var additions []TermAddition
	for at, entry := range tokenRequests {
		if at >= len(added) || len(added[at]) == 0 {
			continue
		}
		additions = append(additions, TermAddition{Token: entry.Token, TypoMatches: entry.TypoMatches, Added: added[at]})
	}
	return additions
}

func MergeAddedWords[M ~struct {
	Token         string
	Factor        float64
	PartialFactor float64
}](members []M, added []AddedWord) []M {
	positionOf := make(map[string]int, len(members))
	for at, member := range members {
		positionOf[Member(member).Token] = at
	}
	for _, word := range added {
		at, found := positionOf[word.Token]
		if !found {
			members = append(members, M(Member{Token: word.Token, Factor: 0, PartialFactor: word.Factor}))
			continue
		}
		member := Member(members[at])
		if word.Factor > member.PartialFactor {
			member.PartialFactor = word.Factor
			members[at] = M(member)
		}
	}
	return members
}

func HighlightWords(queryTokens []QueryToken, written []QueryToken) []string {
	writtenAt := make(map[int]string, len(written))
	for _, word := range written {
		if _, held := writtenAt[word.Position]; !held {
			writtenAt[word.Position] = word.Token
		}
	}
	seenTokens := make(map[string]struct{}, len(queryTokens))
	var words []string
	for _, queryToken := range queryTokens {
		if _, seen := seenTokens[queryToken.Token]; seen {
			continue
		}
		seenTokens[queryToken.Token] = struct{}{}
		word, found := writtenAt[queryToken.Position]
		if !found || !text.ExceedsCodePoints(word, minWrittenWordCodePoints-1) {
			continue
		}
		words = append(words, word)
		if len(words) == maxAddedWordsPerQuery {
			break
		}
	}
	return words
}
