package engine

import "github.com/assetcorp/narsil/packages/go/engine/internal/model"

// Token is one word that a custom tokeniser returns, with its position in
// the text.
type Token = model.Token

// Tokenizer splits text into tokens in place of the language's own rules.
// The engine recovers a panic inside Tokenize and reports it as an error.
type Tokenizer = model.Tokenizer

// StopWordSet holds the words that analysis drops.
type StopWordSet = model.StopWordSet

// NewStopWordSet returns a set holding words.
func NewStopWordSet(words ...string) StopWordSet {
	return model.NewStopWordSet(words...)
}

// StopWordFunction receives the language's own stop words and returns the
// set that analysis drops.
type StopWordFunction = model.StopWordFunction

// StopWords is the stop word setting of an index: a fixed list, a function,
// or a name that RegisterStopWords binds.
type StopWords = model.StopWords

// StopWordList returns a setting that drops exactly words.
func StopWordList(words ...string) StopWords {
	return model.StopWordList(words...)
}

// StopWordsFromSet returns a setting that drops the words of set.
func StopWordsFromSet(set StopWordSet) StopWords {
	return model.StopWordsFromSet(set)
}

// StopWordsFromFunction returns a setting that asks function for the words to
// drop. An engine with durability refuses it, because a restart cannot
// recover code; register the function with RegisterStopWords instead.
func StopWordsFromFunction(function StopWordFunction) StopWords {
	return model.StopWordsFromFunction(function)
}

// NamedStopWords returns a setting that uses the stop words that
// RegisterStopWords binds under name, which survives a restart.
func NamedStopWords(name string) StopWords {
	return model.RegisteredStopWords(name)
}

// TokenizerSetting is the tokeniser setting of an index: an instance, or a
// name that RegisterTokenizer binds.
type TokenizerSetting = model.TokenizerSetting

// UseTokenizer returns a setting that splits text with tokenizer. An engine
// with durability refuses it; register the tokeniser and use NamedTokenizer.
func UseTokenizer(tokenizer Tokenizer) TokenizerSetting {
	return model.CustomTokenizer(tokenizer)
}

// NamedTokenizer returns a setting that splits text with the tokeniser that
// RegisterTokenizer binds under name.
func NamedTokenizer(name string) TokenizerSetting {
	return model.RegisteredTokenizer(name)
}

// SynonymRule makes the engine treat words as one another at query time.
type SynonymRule = model.SynonymRule

// TwoWaySynonyms returns a rule under which each of words matches every other.
func TwoWaySynonyms(words ...string) SynonymRule {
	return model.TwoWaySynonyms(words...)
}

// OneWaySynonyms returns a rule under which word also matches synonyms, while
// each synonym matches itself alone.
func OneWaySynonyms(word string, synonyms ...string) SynonymRule {
	return model.OneWaySynonyms(word, synonyms...)
}

// EmbeddingPurpose tells an embedding adapter whether it embeds a stored
// document or a query.
type EmbeddingPurpose = model.EmbeddingPurpose

const (
	// EmbeddingForDocument marks text taken from a document that the engine stores.
	EmbeddingForDocument = model.EmbeddingForDocument
	// EmbeddingForQuery marks the text of a vector query.
	EmbeddingForQuery = model.EmbeddingForQuery
)

// EmbeddingAdapter turns text into a vector of Dimensions numbers. The engine
// recovers a panic inside Embed and reports it as CodeEmbeddingFailed.
type EmbeddingAdapter = model.EmbeddingAdapter

// BatchEmbeddingAdapter embeds many texts in one call, which the engine uses
// for InsertBatch when an adapter offers it.
type BatchEmbeddingAdapter = model.BatchEmbeddingAdapter

// RerankAdapter scores documents against a query, for a query that sets
// QueryParams.Rerank.
type RerankAdapter = model.RerankAdapter

// AdapterShutdown is what an adapter implements when Shutdown should release
// it.
type AdapterShutdown = model.AdapterShutdown

// PersistenceAdapter saves and loads the files of the snapshot durability
// tier under string keys.
type PersistenceAdapter = model.PersistenceAdapter

// FilesystemPersistenceAdapter is a persistence adapter that writes under a
// directory, which gives the engine write-ahead log durability there.
type FilesystemPersistenceAdapter = model.FilesystemPersistenceAdapter
