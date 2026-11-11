package synonyms

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

const (
	twoWayRuleFields = 1
	oneWayRuleFields = 2
)

func appendWordList(destination []byte, words []string) []byte {
	destination = codec.AppendArrayHeader(destination, len(words))
	for _, word := range words {
		destination = codec.AppendString(destination, word)
	}
	return destination
}

func appendRule(destination []byte, rule model.SynonymRule) []byte {
	if words, isTwoWay := rule.TwoWay(); isTwoWay {
		destination = codec.AppendMapHeader(destination, twoWayRuleFields)
		destination = codec.AppendString(destination, "words")
		return appendWordList(destination, words)
	}
	word, synonyms, _ := rule.OneWay()
	destination = codec.AppendMapHeader(destination, oneWayRuleFields)
	destination = codec.AppendString(destination, "word")
	destination = codec.AppendString(destination, word)
	destination = codec.AppendString(destination, "synonyms")
	return appendWordList(destination, synonyms)
}

func encodeRules(rules []model.SynonymRule) []byte {
	encoded := codec.AppendArrayHeader(nil, len(rules))
	for _, rule := range rules {
		encoded = appendRule(encoded, rule)
	}
	return encoded
}

func DecodeRules(encoded []byte) ([]model.SynonymRule, error) {
	report := problems{}
	decoded, err := codec.UnmarshalAsJavaScript(encoded, codec.DecodeOptions{ErrorCode: narsilerr.CodeConfigInvalid})
	if err != nil {
		return nil, report.invalid("A stored synonym set is not valid MessagePack", map[string]any{})
	}
	return parseRulesValue(decoded, report)
}
