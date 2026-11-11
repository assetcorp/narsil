package index

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/analysis"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/query"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type partialWordOptions struct {
	fields       []string
	tolerance    int
	prefixLength int
}

type partialWordTarget struct {
	token       string
	typoMatches bool
}

func containsField(fields []string, wanted string) bool {
	for _, field := range fields {
		if field == wanted {
			return true
		}
	}
	return false
}

func (ix *Index) partialFieldsFor(params *model.QueryParams) []string {
	if !params.PartialWords || params.Exact {
		return nil
	}
	partial := ix.settings.Schema.PartialFields()
	if len(partial) == 0 || params.Fields == nil {
		return partial
	}
	for _, field := range params.Fields {
		if containsField(partial, field) {
			return partial
		}
	}
	return nil
}

func writtenLongEnough(word string) bool {
	return text.ExceedsCodePoints(word, minPartialWrittenCodePoints-1)
}

func partialWordRequests(term *analysedTerm, written map[int]string, prefixToken string, hasPrefix bool, options partialWordOptions) ([]query.PartialWordRequest, []partialWordTarget) {
	var requests []query.PartialWordRequest
	var targets []partialWordTarget
	for _, token := range term.unique {
		word, found := written[token.Position]
		if !found || !writtenLongEnough(word) {
			continue
		}
		prefix := hasPrefix && token.Token == prefixToken
		tolerance := options.tolerance
		if prefix {
			tolerance = 0
		}
		requests = append(requests, query.PartialWordRequest{
			Written: word, Own: token.Token, Tolerance: uint32(tolerance), PrefixLength: uint32(options.prefixLength),
		})
		targets = append(targets, partialWordTarget{token: token.Token, typoMatches: !prefix})
		if len(requests) == query.PartialWordExpansions {
			break
		}
	}
	return requests, targets
}

func mergeAddedWords(members []query.GroupMember, added []query.PrefixCompletion) []query.GroupMember {
	positionOf := make(map[string]int, len(members))
	for at, member := range members {
		positionOf[member.Token] = at
	}
	for _, word := range added {
		at, found := positionOf[word.Token]
		if !found {
			positionOf[word.Token] = len(members)
			members = append(members, query.GroupMember{Token: word.Token, Factor: 0, PartialFactor: word.Factor})
			continue
		}
		if word.Factor > members[at].PartialFactor {
			members[at].PartialFactor = word.Factor
		}
	}
	return members
}

func addPartialWordMembers(groups *[]query.TermGroup, view *query.View, term *analysedTerm, written map[int]string, options partialWordOptions) error {
	prefixToken, hasPrefix := "", false
	if last, hasLast := term.lastToken(); hasLast {
		for _, group := range *groups {
			if group.Token == last.Token {
				prefixToken, hasPrefix = last.Token, true
			}
		}
	}
	requests, targets := partialWordRequests(term, written, prefixToken, hasPrefix, options)
	if len(requests) == 0 {
		return nil
	}
	added, err := query.ExpandPartialWords(view, requests)
	if err != nil {
		return err
	}
	for at, target := range targets {
		if at >= len(added) || len(added[at]) == 0 {
			continue
		}
		group := groupFor(groups, target.token, target.typoMatches)
		group.Members = mergeAddedWords(group.Members, added[at])
	}
	return nil
}

func partialWordsToHighlight(queryTokens []analysis.Token, written []analysis.Token) []string {
	writtenAt := make(map[int]string, len(written))
	for _, word := range written {
		if _, held := writtenAt[word.Position]; !held {
			writtenAt[word.Position] = word.Term
		}
	}
	seenTokens := make(map[string]struct{}, len(queryTokens))
	var words []string
	for _, token := range queryTokens {
		if _, seen := seenTokens[token.Term]; seen {
			continue
		}
		seenTokens[token.Term] = struct{}{}
		word, found := writtenAt[token.Position]
		if !found || !writtenLongEnough(word) {
			continue
		}
		words = append(words, word)
		if len(words) == query.PartialWordExpansions {
			break
		}
	}
	return words
}

func (ix *Index) partialHighlightFields(params *model.QueryParams) []string {
	var fields []string
	for _, field := range ix.settings.Schema.PartialFields() {
		if params.Fields == nil || containsField(params.Fields, field) {
			fields = append(fields, field)
		}
	}
	return fields
}
