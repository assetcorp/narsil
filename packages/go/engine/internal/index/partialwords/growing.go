package partialwords

import (
	"strings"

	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type GrowingTable struct {
	fields         []string
	entriesByToken map[string]map[string]int32
	entrySpellings []string
	entryTokens    []string
	entryLengths   []int
	entryCounts    []int
	freeEntries    []int32
	runs           map[runKey]map[int32]struct{}
	liveEntries    int
	runMembers     int
}

func NewGrowingTable() *GrowingTable {
	table := &GrowingTable{}
	table.resetSpellings()
	return table
}

func (t *GrowingTable) resetSpellings() {
	t.entriesByToken = map[string]map[string]int32{}
	t.entrySpellings = nil
	t.entryTokens = nil
	t.entryLengths = nil
	t.entryCounts = nil
	t.freeEntries = nil
	t.runs = map[runKey]map[int32]struct{}{}
	t.liveEntries = 0
	t.runMembers = 0
}

func (t *GrowingTable) Fields() []string {
	return t.fields
}

func (t *GrowingTable) AdoptFields(fields []string) bool {
	if SameFields(t.fields, fields) {
		return false
	}
	t.fields = append([]string(nil), fields...)
	t.resetSpellings()
	return true
}

func (t *GrowingTable) Clear() {
	t.fields = nil
	t.resetSpellings()
}

func (t *GrowingTable) ForgetSpellings() {
	t.resetSpellings()
}

func (t *GrowingTable) addEntry(byToken map[string]int32, token, spelling string, count int) {
	length := text.CodePointCount(spelling)
	if length <= runCodePoints {
		return
	}
	var entry int32
	if free := len(t.freeEntries); free > 0 {
		entry = t.freeEntries[free-1]
		t.freeEntries = t.freeEntries[:free-1]
		t.entrySpellings[entry] = spelling
		t.entryTokens[entry] = token
		t.entryLengths[entry] = length
		t.entryCounts[entry] = count
	} else {
		entry = int32(len(t.entrySpellings))
		t.entrySpellings = append(t.entrySpellings, spelling)
		t.entryTokens = append(t.entryTokens, token)
		t.entryLengths = append(t.entryLengths, length)
		t.entryCounts = append(t.entryCounts, count)
	}
	byToken[spelling] = entry
	t.liveEntries++
	t.addToRuns(entry)
}

func (t *GrowingTable) addToRuns(entry int32) {
	points := []rune(t.entrySpellings[entry])
	for at := 0; at+runCodePoints <= len(points); at++ {
		key := runKeyAt(points, at)
		members, found := t.runs[key]
		if !found {
			members = map[int32]struct{}{}
			t.runs[key] = members
		}
		if _, held := members[entry]; held {
			continue
		}
		members[entry] = struct{}{}
		t.runMembers++
	}
}

func (t *GrowingTable) removeFromRuns(entry int32) {
	points := []rune(t.entrySpellings[entry])
	for at := 0; at+runCodePoints <= len(points); at++ {
		key := runKeyAt(points, at)
		members, found := t.runs[key]
		if !found {
			continue
		}
		if _, held := members[entry]; !held {
			continue
		}
		delete(members, entry)
		t.runMembers--
		if len(members) == 0 {
			delete(t.runs, key)
		}
	}
}

func (t *GrowingTable) removeEntry(byToken map[string]int32, token, spelling string, entry int32) {
	t.removeFromRuns(entry)
	delete(byToken, spelling)
	if len(byToken) == 0 {
		delete(t.entriesByToken, token)
	}
	t.entrySpellings[entry] = ""
	t.entryTokens[entry] = ""
	t.entryLengths[entry] = 0
	t.entryCounts[entry] = 0
	t.freeEntries = append(t.freeEntries, entry)
	t.liveEntries--
}

func (t *GrowingTable) Change(token, spelling string, delta int) {
	byToken, found := t.entriesByToken[token]
	if found {
		if entry, held := byToken[spelling]; held {
			after := t.entryCounts[entry] + delta
			if after > 0 {
				t.entryCounts[entry] = after
			} else {
				t.removeEntry(byToken, token, spelling, entry)
			}
			return
		}
	}
	if delta <= 0 {
		return
	}
	if !found {
		byToken = map[string]int32{}
		t.entriesByToken[token] = byToken
	}
	t.addEntry(byToken, token, spelling, delta)
	if len(byToken) == 0 {
		delete(t.entriesByToken, token)
	}
}

func (t *GrowingTable) Apply(counts *SpellingCounts, direction int) {
	if counts == nil {
		return
	}
	for token, bySpelling := range counts.byToken {
		for spelling, count := range bySpelling {
			t.Change(token, spelling, count*direction)
		}
	}
}

func (t *GrowingTable) ApplyEncoded(encoded EncodedSpellings) {
	entries := min(len(encoded.Tokens), len(encoded.Spellings), len(encoded.Counts))
	for at := range entries {
		t.Change(encoded.Tokens[at], encoded.Spellings[at], encoded.Counts[at])
	}
}

func (t *GrowingTable) Encode() (EncodedSpellings, bool) {
	if len(t.fields) == 0 {
		return EncodedSpellings{}, false
	}
	counts := NewSpellingCounts()
	for token, byToken := range t.entriesByToken {
		bySpelling := make(map[string]int, len(byToken))
		for spelling, entry := range byToken {
			bySpelling[spelling] = t.entryCounts[entry]
		}
		counts.byToken[token] = bySpelling
	}
	return counts.Encode(t.fields), true
}

func (t *GrowingTable) Bytes() int {
	return t.liveEntries*growingEntryBytes + len(t.runs)*growingRunBytes + t.runMembers*growingRunMemberBytes
}

func (t *GrowingTable) forEachContaining(written probe, visit func(token string, spellingLength int)) {
	if t == nil {
		return
	}
	points := written.points
	if len(points) < runCodePoints {
		return
	}
	var narrowest map[int32]struct{}
	for at := 0; at+runCodePoints <= len(points); at++ {
		members, found := t.runs[runKeyAt(points, at)]
		if !found {
			return
		}
		if narrowest == nil || len(members) < len(narrowest) {
			narrowest = members
		}
	}
	for entry := range narrowest {
		length := t.entryLengths[entry]
		if length <= len(points) {
			continue
		}
		if !strings.Contains(t.entrySpellings[entry], written.text) {
			continue
		}
		visit(t.entryTokens[entry], length)
	}
}
