package indexsettings

import (
	"strconv"
	"strings"
	"unicode"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/suggestions/phrase"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type phraseLimits struct {
	minLetters int
	maxLength  int
	maxWords   int
	maxDigits  int
}

var banLimits = phraseLimits{
	minLetters: 0,
	maxLength:  MaxBannedPhraseCodePoints,
	maxWords:   MaxBannedPhraseCodePoints,
	maxDigits:  MaxBannedPhraseCodePoints,
}

func isGroupStart(character byte) bool {
	return (character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z') ||
		(character >= '0' && character <= '9')
}

func IsGroup(value string) bool {
	if len(value) == 0 || len(value) > MaxGroupLength || !isGroupStart(value[0]) {
		return false
	}
	for index := 1; index < len(value); index++ {
		if !isGroupStart(value[index]) && value[index] != '_' && value[index] != '-' {
			return false
		}
	}
	return true
}

func phraseFits(phrase string, limits phraseLimits) bool {
	if phrase == "" || text.UTF16Length(phrase) > limits.maxLength*2 {
		return false
	}
	if strings.HasPrefix(phrase, " ") || strings.HasSuffix(phrase, " ") || strings.Contains(phrase, "  ") {
		return false
	}
	letters, digits, codePoints := 0, 0, 0
	for _, character := range phrase {
		codePoints++
		isDigit := unicode.Is(unicode.Nd, character)
		isLetter := unicode.IsLetter(character)
		if !isLetter && !isDigit && !unicode.IsMark(character) && character != ' ' && character != '\'' && character != '-' {
			return false
		}
		if isLetter {
			letters++
		}
		if isDigit {
			digits++
		}
	}
	if codePoints > limits.maxLength || strings.Count(phrase, " ")+1 > limits.maxWords || digits > limits.maxDigits {
		return false
	}
	return letters >= limits.minLetters
}

func isNormalPhrase(candidate string, limits phraseLimits) bool {
	return phraseFits(candidate, limits) && phrase.IsNormal(candidate, phrase.Limits{MinLetters: limits.minLetters,
		MaxLength: limits.maxLength, MaxWords: limits.maxWords, MaxDigits: limits.maxDigits})
}

func ReadBanList(value any) ([]string, error) {
	list, ok := value.([]any)
	if !ok {
		return nil, Invalid("The stored ban list is not an array", nil)
	}
	if len(list) > MaxBannedPhrases {
		return nil, Invalid("A ban list holds at most "+strconv.Itoa(MaxBannedPhrases)+" phrases",
			map[string]any{"phrases": len(list)})
	}
	seen := make(map[string]bool, len(list))
	phrases := make([]string, 0, len(list))
	for _, element := range list {
		phrase, isText := element.(string)
		if !isText || !isNormalPhrase(phrase, banLimits) || seen[phrase] {
			return nil, Invalid("The stored ban list holds a phrase that is not in normal form, or one twice", nil)
		}
		seen[phrase] = true
		phrases = append(phrases, phrase)
	}
	encoded, err := codec.Marshal(phrases, codec.EncodeOptions{})
	if err != nil || len(encoded) > MaxBanListBytes {
		return nil, Invalid("A ban list must encode to at most "+strconv.Itoa(MaxBanListBytes)+" bytes", nil)
	}
	return phrases, nil
}
