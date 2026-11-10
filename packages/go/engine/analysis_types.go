package engine

import "github.com/assetcorp/narsil/packages/go/engine/internal/model"

// AnalysisChange lists the analysis settings that ChangeAnalysis replaces. A
// zero Language, Tokenizer, or StopWords keeps the current value.
type AnalysisChange = model.AnalysisChange

// TokenizerChange is the tokeniser part of an AnalysisChange. Its zero value
// keeps the current tokeniser.
type TokenizerChange = model.TokenizerChange

// StopWordsChange is the stop word part of an AnalysisChange. Its zero value
// keeps the current stop words.
type StopWordsChange = model.StopWordsChange

// ResetTokenizer returns a change that goes back to the language's own
// tokeniser.
func ResetTokenizer() TokenizerChange {
	return model.ResetTokenizer()
}

// ChangeToRegisteredTokenizer returns a change to the tokeniser that
// RegisterTokenizer binds under name.
func ChangeToRegisteredTokenizer(name string) TokenizerChange {
	return model.ChangeToRegisteredTokenizer(name)
}

// ResetStopWords returns a change that goes back to the language's own stop
// words.
func ResetStopWords() StopWordsChange {
	return model.ResetStopWords()
}

// ChangeToRegisteredStopWords returns a change to the stop words that
// RegisterStopWords binds under name.
func ChangeToRegisteredStopWords(name string) StopWordsChange {
	return model.ChangeToRegisteredStopWords(name)
}

// ChangeToStopWordList returns a change that drops exactly words.
func ChangeToStopWordList(words ...string) StopWordsChange {
	return model.ChangeToStopWordList(words...)
}
