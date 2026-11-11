package synonyms

import (
	"time"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

type objectFields struct {
	count int
	get   func(key string) (any, bool)
}

func (fields objectFields) holdsOnly(keys ...string) bool {
	if fields.count != len(keys) {
		return false
	}
	for _, key := range keys {
		if _, found := fields.get(key); !found {
			return false
		}
	}
	return true
}

func (fields objectFields) value(key string) any {
	found, _ := fields.get(key)
	return found
}

func fieldsOfMap(record map[string]any) objectFields {
	return objectFields{count: len(record), get: func(key string) (any, bool) {
		found, present := record[key]
		return found, present
	}}
}

func fieldsOfOrderedMap(record codec.OrderedMap) objectFields {
	return objectFields{count: len(record), get: func(key string) (any, bool) {
		for _, entry := range record {
			if entry.Key == key {
				return entry.Value, true
			}
		}
		return nil, false
	}}
}

func readWordValue(value any, rule int, counted *tally, report problems) (string, error) {
	word, isString := value.(string)
	if !isString {
		return "", report.ruleProblem(rule, "holds a word that is not a string")
	}
	return readWord(word, rule, counted, report)
}

func readWordsValue(value any, rule int, key string, minimum, maximum int, counted *tally, report problems) ([]string, error) {
	switch list := value.(type) {
	case []string:
		return readWords(list, rule, key, minimum, maximum, counted, report)
	case []any:
		if len(list) < minimum || len(list) > maximum {
			return nil, report.listSize(rule, key, minimum, maximum)
		}
		read := make([]string, len(list))
		for at, element := range list {
			word, err := readWordValue(element, rule, counted, report)
			if err != nil {
				return nil, err
			}
			read[at] = word
		}
		return read, nil
	}
	return nil, report.listSize(rule, key, minimum, maximum)
}

func readRuleFields(fields objectFields, rule int, counted *tally, report problems) (model.SynonymRule, error) {
	if fields.holdsOnly("words") {
		words, err := readWordsValue(fields.value("words"), rule, "words", minTwoWaySynonymWords, maxSynonymRuleWords, counted, report)
		if err != nil {
			return model.SynonymRule{}, err
		}
		return model.TwoWaySynonyms(words...), nil
	}
	if !fields.holdsOnly("word", "synonyms") {
		return model.SynonymRule{}, report.mustHoldEither(rule)
	}
	word, err := readWordValue(fields.value("word"), rule, counted, report)
	if err != nil {
		return model.SynonymRule{}, err
	}
	synonyms, err := readWordsValue(fields.value("synonyms"), rule, "synonyms", minOneWaySynonyms, maxSynonymRuleWords-1, counted, report)
	if err != nil {
		return model.SynonymRule{}, err
	}
	return model.OneWaySynonyms(word, synonyms...), nil
}

func readRuleValue(value any, rule int, counted *tally, report problems) (model.SynonymRule, error) {
	switch typed := value.(type) {
	case model.SynonymRule:
		return readTypedRule(typed, rule, counted, report)
	case map[string]any:
		return readRuleFields(fieldsOfMap(typed), rule, counted, report)
	case codec.OrderedMap:
		return readRuleFields(fieldsOfOrderedMap(typed), rule, counted, report)
	case []byte, []float32, time.Time, codec.InvalidDate, codec.Extension:
		return model.SynonymRule{}, report.mustHoldEither(rule)
	}
	return model.SynonymRule{}, report.ruleProblem(rule, "must be an object")
}

func parseRulesValue(value any, report problems) ([]model.SynonymRule, error) {
	switch typed := value.(type) {
	case []model.SynonymRule:
		return parseRules(typed, report)
	case []any:
		if err := requireRuleCount(len(typed), report); err != nil {
			return nil, err
		}
		var counted tally
		parsed := make([]model.SynonymRule, len(typed))
		for rule, element := range typed {
			read, err := readRuleValue(element, rule, &counted, report)
			if err != nil {
				return nil, err
			}
			parsed[rule] = read
		}
		return parsed, nil
	}
	return nil, report.invalid("A synonym set must be a list of rules", map[string]any{})
}
