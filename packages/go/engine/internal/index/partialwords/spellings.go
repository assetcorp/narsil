package partialwords

import (
	"sort"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/analysis"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type SpellingCounts struct {
	byToken map[string]map[string]int
}

type EncodedSpellings struct {
	Fields    []string
	Tokens    []string
	Spellings []string
	Counts    []int
}

func NewSpellingCounts() *SpellingCounts {
	return &SpellingCounts{byToken: map[string]map[string]int{}}
}

func holdsRun(spelling string) bool {
	return text.ExceedsCodePoints(spelling, runCodePoints)
}

func SpellingOf(token analysis.Token) string {
	if token.HasSurface && token.Surface != "" {
		return token.Surface
	}
	return token.Term
}

func (c *SpellingCounts) Count(token, spelling string, change int) {
	if !holdsRun(spelling) {
		return
	}
	byToken, found := c.byToken[token]
	if !found {
		if change <= 0 {
			return
		}
		byToken = map[string]int{}
		c.byToken[token] = byToken
	}
	next := byToken[spelling] + change
	if next > 0 {
		byToken[spelling] = next
		return
	}
	delete(byToken, spelling)
	if len(byToken) == 0 {
		delete(c.byToken, token)
	}
}

func (c *SpellingCounts) CountToken(token analysis.Token) {
	c.Count(token.Term, SpellingOf(token), 1)
}

func (c *SpellingCounts) Add(source *SpellingCounts) {
	for token, bySpelling := range source.byToken {
		for spelling, count := range bySpelling {
			c.Count(token, spelling, count)
		}
	}
}

func (c *SpellingCounts) Len() int {
	entries := 0
	for _, bySpelling := range c.byToken {
		entries += len(bySpelling)
	}
	return entries
}

func (c *SpellingCounts) CountOf(token, spelling string) int {
	return c.byToken[token][spelling]
}

func (c *SpellingCounts) Visit(visit func(token, spelling string, count int)) {
	for _, entry := range c.sortedEntries() {
		visit(entry.token, entry.spelling, entry.count)
	}
}

type countedSpelling struct {
	token    string
	spelling string
	count    int
}

func (c *SpellingCounts) sortedEntries() []countedSpelling {
	entries := make([]countedSpelling, 0, c.Len())
	for token, bySpelling := range c.byToken {
		for spelling, count := range bySpelling {
			entries = append(entries, countedSpelling{token: token, spelling: spelling, count: count})
		}
	}
	sort.Slice(entries, func(left, right int) bool {
		if order := text.CompareCodePoints(entries[left].spelling, entries[right].spelling); order != 0 {
			return order < 0
		}
		return text.CompareCodePoints(entries[left].token, entries[right].token) < 0
	})
	return entries
}

func (c *SpellingCounts) Encode(fields []string) EncodedSpellings {
	entries := c.sortedEntries()
	encoded := EncodedSpellings{
		Fields:    append([]string(nil), fields...),
		Tokens:    make([]string, len(entries)),
		Spellings: make([]string, len(entries)),
		Counts:    make([]int, len(entries)),
	}
	for at, entry := range entries {
		encoded.Tokens[at] = entry.token
		encoded.Spellings[at] = entry.spelling
		encoded.Counts[at] = entry.count
	}
	return encoded
}

func SameFields(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for at := range left {
		if left[at] != right[at] {
			return false
		}
	}
	return true
}

func TextsOf(value any) []string {
	switch typed := value.(type) {
	case string:
		return []string{typed}
	case []any:
		texts := make([]string, 0, len(typed))
		for _, element := range typed {
			if textValue, isText := element.(string); isText {
				texts = append(texts, textValue)
			}
		}
		return texts
	case []string:
		return typed
	}
	return nil
}
