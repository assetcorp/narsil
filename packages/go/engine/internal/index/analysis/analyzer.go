package analysis

import (
	"fmt"
	"sort"
	"sync"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type Options struct {
	Stem             bool
	RemoveStopWords  bool
	RemoveDiacritics bool
	CollectSurfaces  bool
}

var (
	IndexingOptions = Options{Stem: true, RemoveStopWords: true}
	QueryOptions    = Options{Stem: true, RemoveStopWords: true}
	WrittenOptions  = Options{Stem: false, RemoveStopWords: true}
	SurfaceOptions  = Options{Stem: true, RemoveStopWords: true, CollectSurfaces: true}
)

type Token struct {
	Term       string
	Position   int
	Surface    string
	HasSurface bool
	Original   string
}

type CallerFunctionError struct {
	Function string
	Value    any
}

func (e *CallerFunctionError) Error() string {
	return fmt.Sprintf("the caller's %s failed: %v", e.Function, e.Value)
}

type Analyzer struct {
	language     uint32
	languageName string
	defaults     model.StopWordSet
	tokenizer    model.Tokenizer
	fixedStops   *core.StopWordSet
	stopFunction model.StopWordFunction
	heldMu       sync.Mutex
	heldWords    model.StopWordSet
	heldSet      *core.StopWordSet
}

type Settings struct {
	Language  string
	Tokenizer model.Tokenizer
	StopWords model.StopWords
}

func New(settings Settings) (*Analyzer, error) {
	language, found := core.LanguageLookup(settings.Language)
	if !found {
		return nil, narsilerr.New(narsilerr.CodeLanguageNotSupported, `Language "`+settings.Language+`" is not supported`,
			map[string]any{"language": settings.Language})
	}
	words, err := core.LanguageStopWords(language)
	if err != nil {
		return nil, err
	}
	analyzer := &Analyzer{language: language, languageName: core.LanguageName(language), defaults: model.NewStopWordSet(words...), tokenizer: settings.Tokenizer}
	if set, isSet := settings.StopWords.Set(); isSet {
		created, err := core.NewStopWordSet(sortedWords(set))
		if err != nil {
			return nil, err
		}
		analyzer.fixedStops = created
	}
	if function, isFunction := settings.StopWords.Function(); isFunction {
		analyzer.stopFunction = function
	}
	return analyzer, nil
}

func (a *Analyzer) Language() uint32 {
	return a.language
}

func (a *Analyzer) LanguageName() string {
	return a.languageName
}

type Pass struct {
	analyzer *Analyzer
	stops    *core.StopWordSet
}

func (a *Analyzer) Prepare() (*Pass, error) {
	pass := &Pass{analyzer: a, stops: a.fixedStops}
	if a.stopFunction == nil || a.tokenizer != nil {
		return pass, nil
	}
	words, err := a.callStopFunction()
	if err != nil {
		return nil, err
	}
	held, err := a.heldSetFor(words)
	if err != nil {
		return nil, err
	}
	pass.stops = held
	return pass, nil
}

func (a *Analyzer) PrepareWithoutStopWords() *Pass {
	return &Pass{analyzer: a}
}

func (a *Analyzer) callStopFunction() (words model.StopWordSet, err error) {
	defaults := make(model.StopWordSet, len(a.defaults))
	for word := range a.defaults {
		defaults[word] = struct{}{}
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			err = &CallerFunctionError{Function: "stop word function", Value: recovered}
		}
	}()
	return a.stopFunction(defaults), nil
}

func (a *Analyzer) heldSetFor(words model.StopWordSet) (*core.StopWordSet, error) {
	a.heldMu.Lock()
	defer a.heldMu.Unlock()
	if a.heldSet != nil && sameWords(a.heldWords, words) {
		return a.heldSet, nil
	}
	created, err := core.NewStopWordSet(sortedWords(words))
	if err != nil {
		return nil, err
	}
	copied := make(model.StopWordSet, len(words))
	for word := range words {
		copied[word] = struct{}{}
	}
	a.heldWords = copied
	a.heldSet = created
	return created, nil
}

func sameWords(held, words model.StopWordSet) bool {
	if len(held) != len(words) {
		return false
	}
	for word := range words {
		if _, found := held[word]; !found {
			return false
		}
	}
	return true
}

func sortedWords(set model.StopWordSet) []string {
	words := make([]string, 0, len(set))
	for word := range set {
		words = append(words, word)
	}
	sort.Strings(words)
	return words
}

func flagsOf(options Options) core.AnalyseFlags {
	var flags core.AnalyseFlags
	if options.Stem {
		flags |= core.AnalyseStem
	}
	if options.RemoveStopWords {
		flags |= core.AnalyseRemoveStopWords
	}
	if options.RemoveDiacritics {
		flags |= core.AnalyseRemoveDiacritics
	}
	if options.CollectSurfaces {
		flags |= core.AnalyseCollectSurfaces
	}
	return flags
}

type CoreSettings struct {
	Language uint32
	Flags    core.AnalyseFlags
	Stops    *core.StopWordSet
}

func (p *Pass) CoreSettings(options Options) (CoreSettings, bool) {
	if p.analyzer.tokenizer != nil {
		return CoreSettings{}, false
	}
	settings := CoreSettings{Language: p.analyzer.language, Flags: flagsOf(options)}
	if options.RemoveStopWords {
		settings.Stops = p.stops
	}
	return settings, true
}

func (p *Pass) Visit(source string, options Options, visit func(Token)) error {
	if p.analyzer.tokenizer != nil {
		return p.visitCustom(source, visit)
	}
	return p.VisitWithCore(source, options, visit)
}

func (p *Pass) VisitWithCore(source string, options Options, visit func(Token)) error {
	analyser, err := core.AcquireAnalyser()
	if err != nil {
		return err
	}
	defer analyser.Release()
	var stops *core.StopWordSet
	if options.RemoveStopWords {
		stops = p.stops
	}
	return analyser.Analyse(p.analyzer.language, flagsOf(options), source, stops, func(token core.Token) {
		visit(Token{Term: token.Term, Position: int(token.Position), Surface: token.Surface, HasSurface: token.HasSurface, Original: token.Original})
	})
}

func (p *Pass) visitCustom(source string, visit func(Token)) error {
	entries, err := p.customTokens(source)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		term := text.ToWellFormed(entry.Token)
		visit(Token{Term: term, Position: entry.Position, Original: term})
	}
	return nil
}

type TokenPositionError struct {
	Position int
}

func (e *TokenPositionError) Error() string {
	return fmt.Sprintf("The tokenizer returned the position %d, while each position must be a whole number from 0 to %d",
		e.Position, MaxTokenPosition)
}

func (p *Pass) customTokens(source string) ([]model.Token, error) {
	entries, err := p.callTokenizer(source)
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		if entry.Position < 0 || uint64(entry.Position) > MaxTokenPosition {
			return nil, &TokenPositionError{Position: entry.Position}
		}
	}
	if !holdsPositionsOutOfOrder(entries) {
		return entries, nil
	}
	ordered := append([]model.Token(nil), entries...)
	sort.SliceStable(ordered, func(left, right int) bool { return ordered[left].Position < ordered[right].Position })
	return ordered, nil
}

func (p *Pass) callTokenizer(source string) (entries []model.Token, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = &CallerFunctionError{Function: "tokenizer", Value: recovered}
		}
	}()
	return p.analyzer.tokenizer.Tokenize(source), nil
}

func holdsPositionsOutOfOrder(entries []model.Token) bool {
	for at := 1; at < len(entries); at++ {
		if entries[at].Position < entries[at-1].Position {
			return true
		}
	}
	return false
}

func (p *Pass) Tokens(source string, options Options) ([]Token, error) {
	var tokens []Token
	err := p.Visit(source, options, func(token Token) { tokens = append(tokens, token) })
	return tokens, err
}
