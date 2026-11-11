package phrase

import (
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/cases"
	"golang.org/x/text/language"
	"golang.org/x/text/unicode/norm"

	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type Limits struct {
	MinLetters int
	MaxLength  int
	MaxWords   int
	MaxDigits  int
}

func replaceVariants(character rune) rune {
	switch character {
	case '‘', '’', 'ʼ':
		return '\''
	case '‐', '‑':
		return '-'
	}
	return character
}

func collapseWhiteSpace(source string) string {
	var builder strings.Builder
	builder.Grow(len(source))
	inRun := false
	for _, character := range source {
		if unicode.Is(unicode.White_Space, character) {
			if !inRun {
				builder.WriteByte(' ')
			}
			inRun = true
			continue
		}
		inRun = false
		builder.WriteRune(replaceVariants(character))
	}
	return builder.String()
}

func Normalise(raw string, maxLength int) (string, bool) {
	units := text.UTF16Length(raw)
	if units == 0 || units > maxLength*RawUnitsPerCodePoint {
		return "", false
	}
	composed := norm.NFKC.String(raw)
	lowered := cases.Lower(language.Und).String(composed)
	return strings.Trim(collapseWhiteSpace(lowered), " "), true
}

func isAllowed(character rune) bool {
	return unicode.IsLetter(character) || unicode.IsMark(character) || unicode.Is(unicode.Nd, character) ||
		character == ' ' || character == '\'' || character == '-'
}

func Fits(phrase string, limits Limits) bool {
	if phrase == "" || text.UTF16Length(phrase) > limits.MaxLength*2 || !utf8.ValidString(phrase) {
		return false
	}
	if strings.HasPrefix(phrase, " ") || strings.HasSuffix(phrase, " ") || strings.Contains(phrase, "  ") {
		return false
	}
	letters, digits, codePoints := 0, 0, 0
	for _, character := range phrase {
		if !isAllowed(character) {
			return false
		}
		codePoints++
		if unicode.IsLetter(character) {
			letters++
		}
		if unicode.Is(unicode.Nd, character) {
			digits++
		}
	}
	if codePoints > limits.MaxLength || strings.Count(phrase, " ")+1 > limits.MaxWords || digits > limits.MaxDigits {
		return false
	}
	return letters >= limits.MinLetters
}

func IsNormal(phrase string, limits Limits) bool {
	if !Fits(phrase, limits) {
		return false
	}
	normal, ok := Normalise(phrase, limits.MaxLength)
	return ok && normal == phrase
}

func Accepted(raw string, limits Limits) (string, bool) {
	normal, ok := Normalise(raw, limits.MaxLength)
	if !ok || !Fits(normal, limits) {
		return "", false
	}
	return normal, true
}

func IsPerson(value string) bool {
	units := text.UTF16Length(value)
	return units > 0 && units <= MaxPersonUnits
}
