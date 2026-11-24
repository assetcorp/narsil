package index

import (
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/query"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

type foldedKey struct {
	token string
	key   string
}

type foldedWords struct {
	language     uint32
	keys         []foldedKey
	tolerance    uint32
	prefixLength uint32
	prefixFold   string
	hasPrefix    bool
	partialFolds map[string]string
	phraseKeys   [][]string
}

func (ix *Index) SetFoldMarks(foldMarks model.Optional[bool]) {
	ix.foldMarks.Store(&foldMarks)
}

func (ix *Index) FoldMarks() model.Optional[bool] {
	if held := ix.foldMarks.Load(); held != nil {
		return *held
	}
	return model.Optional[bool]{}
}

func (ix *Index) foldingLanguage() (uint32, bool) {
	language := ix.settings.Analyzer.Language()
	if folds, set := ix.FoldMarks().Get(); set {
		return language, folds
	}
	return language, core.LanguageFolds(language)
}

func planFolding(language uint32, term *analysedTerm, written map[int]string, plan *searchPlan) (*foldedWords, error) {
	analyser, err := core.AcquireAnalyser()
	if err != nil {
		return nil, err
	}
	defer analyser.Release()
	folding := &foldedWords{
		language: language, tolerance: uint32(plan.tolerance), prefixLength: uint32(plan.prefixLength),
		partialFolds: map[string]string{},
	}
	for _, token := range term.unique {
		word, found := written[token.Position]
		if !found {
			word = token.Token
		}
		key, err := analyser.FoldSpelling(language, word, true)
		if err != nil {
			return nil, err
		}
		folding.keys = append(folding.keys, foldedKey{token: token.Token, key: key})
		if _, folded := folding.partialFolds[word]; found && !folded && len(plan.partialFields) > 0 && writtenLongEnough(word) {
			if folding.partialFolds[word], err = analyser.FoldSpelling(language, word, false); err != nil {
				return nil, err
			}
		}
	}
	if last, hasLast := term.lastToken(); hasLast && term.usesPrefix {
		if typed := written[last.Position]; typed != "" {
			if folding.prefixFold, err = analyser.FoldSpelling(language, typed, false); err != nil {
				return nil, err
			}
			folding.hasPrefix = true
		}
	}
	for _, phrase := range term.phrases() {
		keys := make([]string, len(phrase.Tokens))
		for at, token := range phrase.Tokens {
			word := token
			if at < len(phrase.Written) {
				word = phrase.Written[at]
			}
			if keys[at], err = analyser.FoldSpelling(language, word, true); err != nil {
				return nil, err
			}
		}
		folding.phraseKeys = append(folding.phraseKeys, keys)
	}
	return folding, nil
}

func (f *foldedWords) wordRequest(groups []query.TermGroup, token, key string) query.FoldedWordRequest {
	request := query.FoldedWordRequest{Key: key, Own: token, Tolerance: f.tolerance, PrefixLength: f.prefixLength}
	for at := range groups {
		if groups[at].Token != token {
			continue
		}
		request.Excluded = groups[at].Synonyms
		if !groups[at].TypoMatches {
			request.Tolerance = 0
		}
		break
	}
	return request
}

func resolveFolding(view *query.View, folding *foldedWords, groups []query.TermGroup, phrases []query.Phrase) ([]query.FoldedTerm, []query.Phrase, error) {
	requests := make([]query.FoldedWordRequest, 0, len(folding.keys))
	for _, word := range folding.keys {
		requests = append(requests, folding.wordRequest(groups, word.token, word.key))
	}
	for at, phrase := range phrases {
		if at >= len(folding.phraseKeys) {
			break
		}
		for position, token := range phrase.Tokens {
			if position < len(folding.phraseKeys[at]) {
				requests = append(requests, query.FoldedWordRequest{Key: folding.phraseKeys[at][position], Own: token})
			}
		}
	}
	found, err := query.ExpandFoldedTerms(view, folding.language, requests)
	if err != nil {
		return nil, nil, err
	}
	var folded []query.FoldedTerm
	for at, word := range folding.keys {
		if at >= len(found) || (len(found[at].Variants) == 0 && len(found[at].TypoMatches) == 0) {
			continue
		}
		variants := found[at].Variants
		for index := range groups {
			if groups[index].Token != word.token || len(variants) == 0 {
				continue
			}
			groups[index].Members = slices.DeleteFunc(groups[index].Members, func(member query.GroupMember) bool {
				return member.Token != word.token && slices.Contains(variants, member.Token)
			})
		}
		folded = append(folded, query.FoldedTerm{Token: word.token, Variants: variants, TypoMatches: found[at].TypoMatches})
	}
	next := len(folding.keys)
	widened := make([]query.Phrase, len(phrases))
	anyVariant := false
	for at, phrase := range phrases {
		widened[at] = phrase
		widened[at].Variants = make([][]string, len(phrase.Tokens))
		for position := range phrase.Tokens {
			if at < len(folding.phraseKeys) && position < len(folding.phraseKeys[at]) && next < len(found) {
				widened[at].Variants[position] = found[next].Variants
				anyVariant = anyVariant || len(found[next].Variants) > 0
				next++
			}
		}
	}
	if !anyVariant {
		return folded, nil, nil
	}
	return folded, widened, nil
}
