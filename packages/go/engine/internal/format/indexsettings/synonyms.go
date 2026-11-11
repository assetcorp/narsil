package indexsettings

import (
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
)

type SynonymRule struct {
	OneWay   bool
	Words    []string
	Word     string
	Synonyms []string
}

type synonymTally struct {
	words int
	bytes int
}

func holdsControlCharacter(word string) bool {
	for index := 0; index < len(word); index++ {
		if word[index] < FirstPrintableCodePoint {
			return true
		}
	}
	return false
}

func synonymProblem(prefix string, message string, details map[string]any) error {
	return Invalid(prefix+message, details)
}

func readSynonymWord(value any, rule int, tally *synonymTally, prefix string) (string, error) {
	word, ok := value.(string)
	if !ok {
		return "", synonymProblem(prefix, "Synonym rule "+strconv.Itoa(rule)+" holds a word that is not a string",
			map[string]any{"rule": rule})
	}
	if holdsControlCharacter(word) {
		return "", synonymProblem(prefix, "Synonym rule "+strconv.Itoa(rule)+" holds a word with a control character",
			map[string]any{"rule": rule})
	}
	tally.words++
	tally.bytes += len(word)
	if tally.words > MaxSynonymWords {
		return "", synonymProblem(prefix, "A synonym set holds at most "+strconv.Itoa(MaxSynonymWords)+" words",
			map[string]any{"maxWords": MaxSynonymWords})
	}
	if tally.bytes > MaxSynonymWordBytes {
		return "", synonymProblem(prefix, "The words of a synonym set hold at most "+
			strconv.Itoa(MaxSynonymWordBytes)+" bytes in UTF-8", map[string]any{"maxWordBytes": MaxSynonymWordBytes})
	}
	return word, nil
}

func readSynonymWords(value any, rule int, key string, minimum int, maximum int, tally *synonymTally, prefix string) ([]string, error) {
	list, ok := value.([]any)
	if !ok || len(list) < minimum || len(list) > maximum {
		return nil, synonymProblem(prefix, "Synonym rule "+strconv.Itoa(rule)+" needs \""+key+"\" as a list of "+
			strconv.Itoa(minimum)+" to "+strconv.Itoa(maximum)+" words", map[string]any{"rule": rule})
	}
	words := make([]string, len(list))
	for index, element := range list {
		word, err := readSynonymWord(element, rule, tally, prefix)
		if err != nil {
			return nil, err
		}
		words[index] = word
	}
	return words, nil
}

func holdsOnlyKeys(record map[string]any, keys ...string) bool {
	if len(record) != len(keys) {
		return false
	}
	for _, key := range keys {
		if _, ok := record[key]; !ok {
			return false
		}
	}
	return true
}

func readSynonymRule(value any, rule int, tally *synonymTally, prefix string) (SynonymRule, error) {
	record, ok := value.(map[string]any)
	if !ok {
		return SynonymRule{}, synonymProblem(prefix, "Synonym rule "+strconv.Itoa(rule)+" must be an object",
			map[string]any{"rule": rule})
	}
	if holdsOnlyKeys(record, "words") {
		words, err := readSynonymWords(record["words"], rule, "words", MinTwoWaySynonymWords, MaxSynonymRuleWords, tally, prefix)
		return SynonymRule{Words: words}, err
	}
	if holdsOnlyKeys(record, "word", "synonyms") {
		word, err := readSynonymWord(record["word"], rule, tally, prefix)
		if err != nil {
			return SynonymRule{}, err
		}
		synonyms, err := readSynonymWords(record["synonyms"], rule, "synonyms", MinOneWaySynonyms,
			MaxSynonymRuleWords-1, tally, prefix)
		return SynonymRule{OneWay: true, Word: word, Synonyms: synonyms}, err
	}
	return SynonymRule{}, synonymProblem(prefix, "Synonym rule "+strconv.Itoa(rule)+
		" must hold either \"words\" alone, or \"word\" and \"synonyms\"", map[string]any{"rule": rule})
}

func ParseSynonymRules(value any, prefix string) ([]SynonymRule, error) {
	list, ok := value.([]any)
	if !ok {
		return nil, synonymProblem(prefix, "A synonym set must be a list of rules", nil)
	}
	if len(list) > MaxSynonymRules {
		return nil, synonymProblem(prefix, "A synonym set holds at most "+strconv.Itoa(MaxSynonymRules)+" rules",
			map[string]any{"maxRules": MaxSynonymRules})
	}
	tally := synonymTally{}
	rules := make([]SynonymRule, len(list))
	for index, element := range list {
		rule, err := readSynonymRule(element, index, &tally, prefix)
		if err != nil {
			return nil, err
		}
		rules[index] = rule
	}
	return rules, nil
}

func SynonymValues(rules []SynonymRule) []any {
	values := make([]any, len(rules))
	for index, rule := range rules {
		if rule.OneWay {
			values[index] = codec.OrderedMap{{Key: "word", Value: rule.Word}, {Key: "synonyms", Value: Texts(rule.Synonyms)}}
			continue
		}
		values[index] = codec.OrderedMap{{Key: "words", Value: Texts(rule.Words)}}
	}
	return values
}
