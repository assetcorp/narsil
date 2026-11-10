package synonyms

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/analysis"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

type Prepared struct {
	Encoded []byte
	Lookup  *Lookup
}

func Prepare(rules []model.SynonymRule, pass *analysis.Pass, strictWords bool, messagePrefix string) (*Prepared, error) {
	report := problems{prefix: messagePrefix}
	parsed, err := parseRules(rules, report)
	if err != nil {
		return nil, err
	}
	return prepareParsed(parsed, pass, strictWords, report)
}

func PrepareValue(value any, pass *analysis.Pass, strictWords bool, messagePrefix string) (*Prepared, error) {
	report := problems{prefix: messagePrefix}
	parsed, err := parseRulesValue(value, report)
	if err != nil {
		return nil, err
	}
	return prepareParsed(parsed, pass, strictWords, report)
}

func prepareParsed(rules []model.SynonymRule, pass *analysis.Pass, strictWords bool, report problems) (*Prepared, error) {
	if len(rules) == 0 {
		return nil, nil
	}
	var strict *problems
	if strictWords {
		strict = &report
	}
	lookup, err := buildLookup(rules, pass, strict)
	if err != nil {
		return nil, err
	}
	return &Prepared{Encoded: encodeRules(rules), Lookup: lookup}, nil
}

func StoredLookup(encoded []byte, pass *analysis.Pass) (*Lookup, error) {
	rules, err := DecodeRules(encoded)
	if err != nil {
		return nil, err
	}
	return buildLookup(rules, pass, nil)
}
