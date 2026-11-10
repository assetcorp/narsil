package query

import "github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"

func invalidPhrase(message string, details map[string]any) error {
	return narsilerr.New(narsilerr.CodeSearchInvalidPhrase, message, details)
}

func validatePhrases(phrases []Phrase) error {
	if len(phrases) > MaxQueryPhrases {
		return invalidPhrase("The query holds more phrases than a search takes", map[string]any{"limit": MaxQueryPhrases, "phrases": len(phrases)})
	}
	for index := range phrases {
		phrase := &phrases[index]
		if len(phrase.Tokens) == 0 || len(phrase.Offsets) != len(phrase.Tokens) {
			return invalidPhrase("A phrase needs one offset for every token", map[string]any{"phrase": index})
		}
		if phrase.Offsets[0] != 0 {
			return invalidPhrase("A phrase starts at offset zero", map[string]any{"phrase": index})
		}
		for at := 1; at < len(phrase.Offsets); at++ {
			if phrase.Offsets[at] < phrase.Offsets[at-1] {
				return invalidPhrase("A phrase lists its offsets in ascending order", map[string]any{"phrase": index})
			}
		}
		words := max(len(phrase.Tokens), int(phrase.Offsets[len(phrase.Offsets)-1])+1)
		if len(phrase.Tokens) > MaxPhraseWords || phrase.Offsets[len(phrase.Offsets)-1] >= MaxPhraseWords {
			return invalidPhrase("A phrase holds more words than a search takes", map[string]any{"limit": MaxPhraseWords, "words": words})
		}
	}
	return nil
}
