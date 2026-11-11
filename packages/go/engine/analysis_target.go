package engine

import (
	"sort"
	"strings"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/indexconfig"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/metadata"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/analysis"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/synonyms"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

type analysisTarget struct {
	language  string
	tokenizer model.TokenizerSetting
	stopWords model.StopWords
	described analysisSettings
	analyzer  *analysis.Analyzer
}

func tokenizerKey(setting model.TokenizerSetting) string {
	if _, custom := setting.Custom(); custom {
		return "instance"
	}
	if name, named := setting.RegisteredName(); named {
		return "name:" + name
	}
	return ""
}

func stopWordsKey(setting model.StopWords) string {
	if set, listed := setting.Set(); listed {
		return "list:" + strings.Join(stopWordListOf(set), "\x00")
	}
	if _, function := setting.Function(); function {
		return "function"
	}
	if name, named := setting.RegisteredName(); named {
		return "name:" + name
	}
	return ""
}

func (target analysisTarget) holds(language string, tokenizer model.TokenizerSetting, stopWords model.StopWords) bool {
	return target.language == language && tokenizerKey(target.tokenizer) == tokenizerKey(tokenizer) &&
		stopWordsKey(target.stopWords) == stopWordsKey(stopWords)
}

func (entry *indexEntry) heldBy(target analysisTarget) bool {
	entry.settingsMu.RLock()
	defer entry.settingsMu.RUnlock()
	return target.holds(entry.analysis.language, entry.config.Tokenizer, entry.config.StopWords)
}

func (target analysisTarget) sameAs(other analysisTarget) bool {
	return target.holds(other.language, other.tokenizer, other.stopWords)
}

func (n *Narsil) resolveTarget(entry *indexEntry, language string, tokenizer model.TokenizerSetting,
	stopWords model.StopWords) (analysisTarget, error) {
	languageOnly, err := analysis.New(analysis.Settings{Language: language})
	if err != nil {
		return analysisTarget{}, err
	}
	config := entry.currentConfig()
	config.Language, config.Tokenizer, config.StopWords = languageOnly.LanguageName(), tokenizer, stopWords
	settings, described, err := n.resolveAnalysis(config)
	if err != nil {
		return analysisTarget{}, err
	}
	analyzer, err := analysis.New(settings)
	if err != nil {
		return analysisTarget{}, err
	}
	described.language = analyzer.LanguageName()
	described.revision = core.LanguageRevision(analyzer.Language())
	return analysisTarget{language: described.language, tokenizer: tokenizer, stopWords: stopWords,
		described: described, analyzer: analyzer}, nil
}

func (n *Narsil) targetOfChange(entry *indexEntry, change model.AnalysisChange) (analysisTarget, error) {
	config := entry.currentConfig()
	language := entry.currentAnalysis().language
	if requested, set := change.Language.Get(); set {
		language = requested
	}
	tokenizer := config.Tokenizer
	if change.Tokenizer.ResetsToLanguage() {
		tokenizer = model.TokenizerSetting{}
	} else if name, named := change.Tokenizer.RegisteredName(); named {
		tokenizer = model.RegisteredTokenizer(name)
	}
	stopWords := config.StopWords
	if change.StopWords.ResetsToLanguage() {
		stopWords = model.StopWords{}
	} else if name, named := change.StopWords.RegisteredName(); named {
		stopWords = model.RegisteredStopWords(name)
	} else if words, listed := change.StopWords.Words(); listed {
		stopWords = model.StopWordList(words...)
	}
	if _, err := analysis.New(analysis.Settings{Language: language}); err != nil {
		return analysisTarget{}, err
	}
	if err := entry.requireConfigurationFits(language, tokenizer, stopWords); err != nil {
		return analysisTarget{}, err
	}
	return n.resolveTarget(entry, language, tokenizer, stopWords)
}

func (entry *indexEntry) requireConfigurationFits(language string, tokenizer model.TokenizerSetting,
	stopWords model.StopWords) error {
	configuration := entry.configurationFields()
	configuration.Language = language
	configuration.Tokenizer, configuration.StopWords, configuration.StopWordList =
		model.Optional[string]{}, model.Optional[string]{}, model.Optional[[]string]{}
	if name, named := tokenizer.RegisteredName(); named {
		configuration.Tokenizer = model.Some(name)
	}
	if name, named := stopWords.RegisteredName(); named {
		configuration.StopWords = model.Some(name)
	} else if set, listed := stopWords.Set(); listed {
		configuration.StopWordList = model.Some(stopWordListOf(set))
	}
	_, err := indexconfig.Encode(configuration)
	return err
}

func (target analysisTarget) pendingAt(generation uint64) *metadata.PendingAnalysis {
	return &metadata.PendingAnalysis{Generation: generation, Language: target.language,
		Tokenizer: target.described.tokenizer, StopWords: target.described.stopWords,
		StopWordList: target.described.stopWordList}
}

func (n *Narsil) targetOfPending(entry *indexEntry, pending metadata.PendingAnalysis) (analysisTarget, error) {
	tokenizer := model.TokenizerSetting{}
	if name, named := pending.Tokenizer.Get(); named {
		tokenizer = model.RegisteredTokenizer(name)
	}
	stopWords := model.StopWords{}
	if name, named := pending.StopWords.Get(); named {
		stopWords = model.RegisteredStopWords(name)
	} else if words, listed := pending.StopWordList.Get(); listed {
		sorted := append([]string(nil), words...)
		sort.Strings(sorted)
		stopWords = model.StopWordList(sorted...)
	}
	return n.resolveTarget(entry, pending.Language, tokenizer, stopWords)
}

func (entry *indexEntry) prepareSynonymRules(rules []model.SynonymRule) (*synonyms.Lookup, []model.SynonymRule, error) {
	lookup, canonical, err := prepareSynonyms(entry.currentAnalyzer(), rules, true)
	if err != nil {
		return nil, nil, err
	}
	entry.swap.mu.Lock()
	run := entry.swap.change
	entry.swap.mu.Unlock()
	if run != nil {
		if _, _, err := prepareSynonyms(run.target.analyzer, rules, true); err != nil {
			return nil, nil, err
		}
	}
	return lookup, canonical, nil
}

func (entry *indexEntry) synonymsUnderHeldSettings(lookup *synonyms.Lookup, canonical []model.SynonymRule) *synonyms.Lookup {
	prepared, _, err := prepareSynonyms(entry.analyzer, canonical, false)
	if err != nil {
		return lookup
	}
	return prepared
}

func (entry *indexEntry) requireSynonymsUnder(target analysisTarget) error {
	rules := entry.currentConfig().Synonyms
	if len(rules) == 0 {
		return nil
	}
	_, _, err := prepareSynonyms(target.analyzer, rules, true)
	return err
}
