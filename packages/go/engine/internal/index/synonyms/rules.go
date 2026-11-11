package synonyms

import (
	"fmt"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

const firstPrintableCode = 0x20

type problems struct {
	prefix string
}

func (p problems) invalid(message string, details map[string]any) error {
	return narsilerr.New(narsilerr.CodeConfigInvalid, p.prefix+message, details)
}

func (p problems) ruleProblem(rule int, message string) error {
	return p.invalid("Synonym rule "+strconv.Itoa(rule)+" "+message, map[string]any{"rule": rule})
}

func (p problems) mustHoldEither(rule int) error {
	return p.ruleProblem(rule, `must hold either "words" alone, or "word" and "synonyms"`)
}

func (p problems) listSize(rule int, key string, minimum, maximum int) error {
	return p.ruleProblem(rule, fmt.Sprintf(`needs "%s" as a list of %d to %d words`, key, minimum, maximum))
}

type tally struct {
	words int
	bytes int
}

func holdsControlCharacter(word string) bool {
	for at := 0; at < len(word); at++ {
		if word[at] < firstPrintableCode {
			return true
		}
	}
	return false
}

func readWord(word string, rule int, counted *tally, report problems) (string, error) {
	wellFormed := text.ToWellFormed(word)
	if holdsControlCharacter(wellFormed) {
		return "", report.ruleProblem(rule, "holds a word with a control character")
	}
	counted.words++
	counted.bytes += len(wellFormed)
	if counted.words > maxSynonymWords {
		return "", report.invalid(fmt.Sprintf("A synonym set holds at most %d words", maxSynonymWords),
			map[string]any{"maxWords": maxSynonymWords})
	}
	if counted.bytes > maxSynonymWordBytes {
		return "", report.invalid(fmt.Sprintf("The words of a synonym set hold at most %d bytes in UTF-8", maxSynonymWordBytes),
			map[string]any{"maxWordBytes": maxSynonymWordBytes})
	}
	return wellFormed, nil
}

func readWords(words []string, rule int, key string, minimum, maximum int, counted *tally, report problems) ([]string, error) {
	if len(words) < minimum || len(words) > maximum {
		return nil, report.listSize(rule, key, minimum, maximum)
	}
	read := make([]string, len(words))
	for at, word := range words {
		checked, err := readWord(word, rule, counted, report)
		if err != nil {
			return nil, err
		}
		read[at] = checked
	}
	return read, nil
}

func readTypedRule(value model.SynonymRule, rule int, counted *tally, report problems) (model.SynonymRule, error) {
	if words, isTwoWay := value.TwoWay(); isTwoWay {
		read, err := readWords(words, rule, "words", minTwoWaySynonymWords, maxSynonymRuleWords, counted, report)
		if err != nil {
			return model.SynonymRule{}, err
		}
		return model.TwoWaySynonyms(read...), nil
	}
	word, synonyms, isOneWay := value.OneWay()
	if !isOneWay {
		return model.SynonymRule{}, report.mustHoldEither(rule)
	}
	return readOneWay(word, synonyms, rule, counted, report)
}

func readOneWay(word string, synonyms []string, rule int, counted *tally, report problems) (model.SynonymRule, error) {
	source, err := readWord(word, rule, counted, report)
	if err != nil {
		return model.SynonymRule{}, err
	}
	read, err := readWords(synonyms, rule, "synonyms", minOneWaySynonyms, maxSynonymRuleWords-1, counted, report)
	if err != nil {
		return model.SynonymRule{}, err
	}
	return model.OneWaySynonyms(source, read...), nil
}

func parseRules(rules []model.SynonymRule, report problems) ([]model.SynonymRule, error) {
	if err := requireRuleCount(len(rules), report); err != nil {
		return nil, err
	}
	var counted tally
	parsed := make([]model.SynonymRule, len(rules))
	for rule, value := range rules {
		read, err := readTypedRule(value, rule, &counted, report)
		if err != nil {
			return nil, err
		}
		parsed[rule] = read
	}
	return parsed, nil
}

func requireRuleCount(count int, report problems) error {
	if count > maxSynonymRules {
		return report.invalid(fmt.Sprintf("A synonym set holds at most %d rules", maxSynonymRules),
			map[string]any{"maxRules": maxSynonymRules})
	}
	return nil
}
