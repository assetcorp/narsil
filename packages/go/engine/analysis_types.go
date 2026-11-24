package engine

import "github.com/assetcorp/narsil/packages/go/engine/internal/model"

// AnalysisChange lists the analysis settings that ChangeAnalysis replaces. A
// zero Language, Tokenizer, StopWords, or FoldMarks keeps the current value.
type AnalysisChange = model.AnalysisChange

// FoldMarksChange is the folded matching part of an AnalysisChange. Its zero
// value keeps the current setting.
type FoldMarksChange = model.FoldMarksChange

// ResetFoldMarks returns a change that goes back to the language's default
// for folded matching.
func ResetFoldMarks() FoldMarksChange {
	return model.ResetFoldMarks()
}

// ChangeFoldMarks returns a change that turns folded matching on or off, so
// that a query typed without marks matches the words that carry them only
// where on is true. The engine applies it from the next query with no
// rebuild, because folded matching changes no stored term.
func ChangeFoldMarks(on bool) FoldMarksChange {
	return model.ChangeFoldMarks(on)
}

// TokenizerChange is the tokeniser part of an AnalysisChange. Its zero value
// keeps the current tokeniser.
type TokenizerChange = model.TokenizerChange

// StopWordsChange is the stop word part of an AnalysisChange. Its zero value
// keeps the current stop words.
type StopWordsChange = model.StopWordsChange

// ResetTokenizer returns a change that goes back to the tokeniser that the
// language of the index defines.
func ResetTokenizer() TokenizerChange {
	return model.ResetTokenizer()
}

// ChangeToRegisteredTokenizer returns a change to the tokeniser that
// RegisterTokenizer binds under name.
func ChangeToRegisteredTokenizer(name string) TokenizerChange {
	return model.ChangeToRegisteredTokenizer(name)
}

// ResetStopWords returns a change that goes back to the stop words that the
// language of the index defines.
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
