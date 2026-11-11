package model

import "regexp"

type Token struct {
	Token    string
	Position int
}

type Tokenizer interface {
	Tokenize(text string) []Token
}

type StopWordSet map[string]struct{}

func NewStopWordSet(words ...string) StopWordSet {
	set := make(StopWordSet, len(words))
	for _, word := range words {
		set[word] = struct{}{}
	}
	return set
}

type StopWordFunction func(defaults StopWordSet) StopWordSet

type TokenizerConfig struct {
	SplitPattern        *regexp.Regexp
	NormalizeDiacritics Optional[bool]
	MinTokenLength      Optional[int]
	StripPossessive     Optional[bool]
	NgramSize           Optional[int]
}

type LanguageModule struct {
	Name       string
	Revision   string
	Stemmer    func(token string) string
	StopWords  StopWordSet
	Normalizer func(token string) string
	Tokenizer  *TokenizerConfig
}

type stopWordsKind uint8

const (
	stopWordsAbsent stopWordsKind = iota
	stopWordsSet
	stopWordsFunction
	stopWordsRegistered
)

type StopWords struct {
	kind     stopWordsKind
	set      StopWordSet
	function StopWordFunction
	name     string
}

func StopWordList(words ...string) StopWords {
	return StopWords{kind: stopWordsSet, set: NewStopWordSet(words...)}
}

func StopWordsFromSet(set StopWordSet) StopWords {
	copied := make(StopWordSet, len(set))
	for word := range set {
		copied[word] = struct{}{}
	}
	return StopWords{kind: stopWordsSet, set: copied}
}

func StopWordsFromFunction(function StopWordFunction) StopWords {
	return StopWords{kind: stopWordsFunction, function: function}
}

func RegisteredStopWords(name string) StopWords {
	return StopWords{kind: stopWordsRegistered, name: name}
}

func (s StopWords) IsSet() bool {
	return s.kind != stopWordsAbsent
}

func (s StopWords) Set() (StopWordSet, bool) {
	return s.set, s.kind == stopWordsSet
}

func (s StopWords) Function() (StopWordFunction, bool) {
	return s.function, s.kind == stopWordsFunction
}

func (s StopWords) RegisteredName() (string, bool) {
	return s.name, s.kind == stopWordsRegistered
}

type tokenizerSettingKind uint8

const (
	tokenizerAbsent tokenizerSettingKind = iota
	tokenizerCustom
	tokenizerRegistered
)

type TokenizerSetting struct {
	kind      tokenizerSettingKind
	tokenizer Tokenizer
	name      string
}

func CustomTokenizer(tokenizer Tokenizer) TokenizerSetting {
	return TokenizerSetting{kind: tokenizerCustom, tokenizer: tokenizer}
}

func RegisteredTokenizer(name string) TokenizerSetting {
	return TokenizerSetting{kind: tokenizerRegistered, name: name}
}

func (s TokenizerSetting) IsSet() bool {
	return s.kind != tokenizerAbsent
}

func (s TokenizerSetting) Custom() (Tokenizer, bool) {
	return s.tokenizer, s.kind == tokenizerCustom
}

func (s TokenizerSetting) RegisteredName() (string, bool) {
	return s.name, s.kind == tokenizerRegistered
}

type analysisChangeKind uint8

const (
	analysisChangeKeep analysisChangeKind = iota
	analysisChangeReset
	analysisChangeRegistered
	analysisChangeList
)

type TokenizerChange struct {
	kind analysisChangeKind
	name string
}

func ResetTokenizer() TokenizerChange {
	return TokenizerChange{kind: analysisChangeReset}
}

func ChangeToRegisteredTokenizer(name string) TokenizerChange {
	return TokenizerChange{kind: analysisChangeRegistered, name: name}
}

func (c TokenizerChange) KeepsCurrent() bool {
	return c.kind == analysisChangeKeep
}

func (c TokenizerChange) ResetsToLanguage() bool {
	return c.kind == analysisChangeReset
}

func (c TokenizerChange) RegisteredName() (string, bool) {
	return c.name, c.kind == analysisChangeRegistered
}

type StopWordsChange struct {
	kind  analysisChangeKind
	name  string
	words []string
}

func ResetStopWords() StopWordsChange {
	return StopWordsChange{kind: analysisChangeReset}
}

func ChangeToRegisteredStopWords(name string) StopWordsChange {
	return StopWordsChange{kind: analysisChangeRegistered, name: name}
}

func ChangeToStopWordList(words ...string) StopWordsChange {
	return StopWordsChange{kind: analysisChangeList, words: append([]string{}, words...)}
}

func (c StopWordsChange) KeepsCurrent() bool {
	return c.kind == analysisChangeKeep
}

func (c StopWordsChange) ResetsToLanguage() bool {
	return c.kind == analysisChangeReset
}

func (c StopWordsChange) RegisteredName() (string, bool) {
	return c.name, c.kind == analysisChangeRegistered
}

func (c StopWordsChange) Words() ([]string, bool) {
	return append([]string(nil), c.words...), c.kind == analysisChangeList
}

type AnalysisChange struct {
	Language  Optional[string]
	Tokenizer TokenizerChange
	StopWords StopWordsChange
}

type synonymRuleKind uint8

const (
	synonymRuleUnset synonymRuleKind = iota
	synonymRuleTwoWay
	synonymRuleOneWay
)

type SynonymRule struct {
	kind     synonymRuleKind
	words    []string
	word     string
	synonyms []string
}

func TwoWaySynonyms(words ...string) SynonymRule {
	return SynonymRule{kind: synonymRuleTwoWay, words: append([]string{}, words...)}
}

func OneWaySynonyms(word string, synonyms ...string) SynonymRule {
	return SynonymRule{kind: synonymRuleOneWay, word: word, synonyms: append([]string{}, synonyms...)}
}

func (r SynonymRule) TwoWay() ([]string, bool) {
	return append([]string(nil), r.words...), r.kind == synonymRuleTwoWay
}

func (r SynonymRule) OneWay() (string, []string, bool) {
	return r.word, append([]string(nil), r.synonyms...), r.kind == synonymRuleOneWay
}

func (r SynonymRule) IsSet() bool {
	return r.kind != synonymRuleUnset
}
