package synonyms

import (
	"fmt"
	"slices"
	"strings"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/analysis"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

const (
	noSourceToken     = -1
	uint32ElementSize = 4
)

type analysedWord struct {
	token      string
	tokenCount int
}

type lookupBuilder struct {
	pass      *analysis.Pass
	strict    *problems
	analysed  map[string]analysedWord
	tokenIDs  map[string]uint32
	tokens    []string
	ruleStart []uint32
	ruleIDs   []uint32
	sources   []int32
}

func (b *lookupBuilder) analyse(word string) (analysedWord, error) {
	if cached, found := b.analysed[word]; found {
		return cached, nil
	}
	var result analysedWord
	err := b.pass.Visit(word, analysis.IndexingOptions, func(token analysis.Token) {
		if result.tokenCount == 0 {
			result.token = text.ToWellFormed(token.Term)
		}
		result.tokenCount++
	})
	if err != nil {
		return analysedWord{}, err
	}
	b.analysed[word] = result
	return result, nil
}

func (b *lookupBuilder) tokenOf(word string, rule int) (string, bool, error) {
	result, err := b.analyse(word)
	if err != nil {
		return "", false, err
	}
	if result.tokenCount == 1 {
		return result.token, true, nil
	}
	if b.strict != nil {
		reason := "to no token, as a stop word does"
		if result.tokenCount > 0 {
			reason = fmt.Sprintf("to %d tokens, as a phrase does", result.tokenCount)
		}
		return "", false, b.strict.invalid(fmt.Sprintf("Synonym rule %d holds a word that the index analyses %s", rule, reason),
			map[string]any{"rule": rule, "tokens": result.tokenCount})
	}
	return "", false, nil
}

func (b *lookupBuilder) intern(token string) uint32 {
	if id, found := b.tokenIDs[token]; found {
		return id
	}
	id := uint32(len(b.tokens))
	b.tokens = append(b.tokens, token)
	b.tokenIDs[token] = id
	return id
}

func (b *lookupBuilder) addRule(rule int, value model.SynonymRule) error {
	targets, isTwoWay := value.TwoWay()
	source, synonyms, _ := value.OneWay()
	sourceToken, sourceKept := "", isTwoWay
	if !isTwoWay {
		targets = synonyms
		var err error
		if sourceToken, sourceKept, err = b.tokenOf(source, rule); err != nil {
			return err
		}
	}
	seen := make(map[uint32]struct{}, len(targets))
	for _, word := range targets {
		token, analysed, err := b.tokenOf(word, rule)
		if err != nil {
			return err
		}
		if !analysed {
			continue
		}
		id := b.intern(token)
		if _, repeated := seen[id]; repeated {
			continue
		}
		seen[id] = struct{}{}
		b.ruleIDs = append(b.ruleIDs, id)
	}
	if !isTwoWay && sourceKept {
		b.sources[rule] = int32(b.intern(sourceToken))
	}
	if !sourceKept {
		b.ruleIDs = b.ruleIDs[:b.ruleStart[rule]]
	}
	b.ruleStart[rule+1] = uint32(len(b.ruleIDs))
	return nil
}

func buildLookup(rules []model.SynonymRule, pass *analysis.Pass, strict *problems) (*Lookup, error) {
	builder := &lookupBuilder{
		pass:      pass,
		strict:    strict,
		analysed:  map[string]analysedWord{},
		tokenIDs:  map[string]uint32{},
		ruleStart: make([]uint32, len(rules)+1),
		sources:   make([]int32, len(rules)),
	}
	for rule := range builder.sources {
		builder.sources[rule] = noSourceToken
	}
	for rule, value := range rules {
		if err := builder.addRule(rule, value); err != nil {
			return nil, err
		}
	}
	if len(builder.ruleIDs) == 0 {
		return nil, nil
	}
	return builder.pack(), nil
}

func (b *lookupBuilder) pack() *Lookup {
	tokenCount := len(b.tokens)
	order := make([]uint32, tokenCount)
	for id := range order {
		order[id] = uint32(id)
	}
	slices.SortFunc(order, func(left, right uint32) int { return strings.Compare(b.tokens[left], b.tokens[right]) })
	rank := make([]uint32, tokenCount)
	offsets := make([]uint32, tokenCount+1)
	var blob []byte
	for position, id := range order {
		rank[id] = uint32(position)
		blob = append(blob, b.tokens[id]...)
		offsets[position+1] = uint32(len(blob))
	}
	ruleTokens := make([]uint32, len(b.ruleIDs))
	for at, id := range b.ruleIDs {
		ruleTokens[at] = rank[id]
	}
	tokenRuleStart := make([]uint32, tokenCount+1)
	b.visitOpenings(rank, func(token uint32, _ int) { tokenRuleStart[token+1]++ })
	for token := range tokenCount {
		tokenRuleStart[token+1] += tokenRuleStart[token]
	}
	tokenRules := make([]uint32, tokenRuleStart[tokenCount])
	fill := slices.Clone(tokenRuleStart[:tokenCount])
	b.visitOpenings(rank, func(token uint32, rule int) {
		tokenRules[fill[token]] = uint32(rule)
		fill[token]++
	})
	arrayElements := len(offsets) + len(b.ruleStart) + len(ruleTokens) + len(b.sources) + len(tokenRuleStart) + len(tokenRules)
	return &Lookup{
		blob:           blob,
		offsets:        offsets,
		ruleStart:      b.ruleStart,
		ruleTokens:     ruleTokens,
		tokenRuleStart: tokenRuleStart,
		tokenRules:     tokenRules,
		tokenCount:     tokenCount,
		bytes:          int64(len(blob)) + int64(arrayElements)*uint32ElementSize,
		cache:          newSynonymCache(),
	}
}

func (b *lookupBuilder) visitOpenings(rank []uint32, visit func(token uint32, rule int)) {
	for rule, source := range b.sources {
		if source != noSourceToken {
			visit(rank[source], rule)
			continue
		}
		for at := b.ruleStart[rule]; at < b.ruleStart[rule+1]; at++ {
			visit(rank[b.ruleIDs[at]], rule)
		}
	}
}
