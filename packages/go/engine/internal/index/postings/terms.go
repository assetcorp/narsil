package postings

import (
	"strings"
	"unicode/utf8"

	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

const noSlice = uint8(255)

const (
	termLive uint8 = 1 << iota
	termOrdered
	termPositions
)

type termColumn struct {
	start              uint32
	length             uint32
	documentFrequency  uint32
	deadDocuments      uint32
	totalTermFrequency float64
	class              uint8
	flags              uint8
}

type bucket struct {
	ordinals []uint32
	dead     int
}

type termTable struct {
	ids            map[string]uint32
	tokens         []string
	columns        []termColumn
	liveCount      int
	tokenCodeUnits int
	buckets        map[rune]*bucket
}

func newTermTable() termTable {
	return termTable{ids: map[string]uint32{}, buckets: map[rune]*bucket{}}
}

func firstRune(token string) (rune, bool) {
	if token == "" {
		return 0, false
	}
	first, _ := utf8.DecodeRuneInString(token)
	return first, true
}

func (t *termTable) add(token string) uint32 {
	ordinal := uint32(len(t.tokens))
	t.ids[token] = ordinal
	t.tokens = append(t.tokens, token)
	t.columns = append(t.columns, termColumn{class: noSlice, flags: termLive | termOrdered})
	t.liveCount++
	t.tokenCodeUnits += text.UTF16Length(token)
	if first, found := firstRune(token); found {
		held := t.buckets[first]
		if held == nil {
			held = &bucket{ordinals: make([]uint32, 0, firstBucketCapacity)}
			t.buckets[first] = held
		}
		held.ordinals = append(held.ordinals, ordinal)
	}
	return ordinal
}

func (t *termTable) isLive(ordinal uint32) bool {
	return t.columns[ordinal].flags&termLive != 0
}

func (t *termTable) kill(ordinal uint32) {
	token := t.tokens[ordinal]
	delete(t.ids, token)
	if first, found := firstRune(token); found {
		if held := t.buckets[first]; held != nil {
			held.dead++
			t.compactBucket(first, held)
		}
	}
	t.tokens[ordinal] = ""
	t.columns[ordinal] = termColumn{class: noSlice}
	t.liveCount--
	t.tokenCodeUnits -= text.UTF16Length(token)
}

func (t *termTable) deadCount() int {
	return len(t.tokens) - t.liveCount
}

func (t *termTable) forEachLive(visit func(ordinal uint32)) {
	for ordinal := range t.columns {
		if t.columns[ordinal].flags&termLive != 0 {
			visit(uint32(ordinal))
		}
	}
}

func (t *termTable) forEachStartingWith(prefix string, visit func(ordinal uint32)) {
	first, found := firstRune(prefix)
	if !found {
		t.forEachLive(visit)
		return
	}
	held := t.buckets[first]
	if held == nil {
		return
	}
	checkPrefix := len(prefix) > utf8.RuneLen(first)
	for _, ordinal := range held.ordinals {
		if t.columns[ordinal].flags&termLive == 0 {
			continue
		}
		if checkPrefix && !strings.HasPrefix(t.tokens[ordinal], prefix) {
			continue
		}
		visit(ordinal)
	}
}

func (t *termTable) compactBucket(first rune, held *bucket) {
	if held.dead*2 <= len(held.ordinals) {
		return
	}
	kept := held.ordinals[:0]
	for _, ordinal := range held.ordinals {
		if t.columns[ordinal].flags&termLive != 0 {
			kept = append(kept, ordinal)
		}
	}
	held.ordinals = kept
	held.dead = 0
	if len(kept) == 0 {
		delete(t.buckets, first)
	}
}

func (t *termTable) renumber() []int64 {
	remap := make([]int64, len(t.tokens))
	next := newTermTable()
	next.columns = make([]termColumn, 0, t.liveCount)
	next.tokens = make([]string, 0, t.liveCount)
	for ordinal := range t.tokens {
		remap[ordinal] = -1
		if t.columns[ordinal].flags&termLive == 0 {
			continue
		}
		target := next.add(t.tokens[ordinal])
		remap[ordinal] = int64(target)
		next.columns[target] = t.columns[ordinal]
	}
	*t = next
	return remap
}

func (t *termTable) estimateBytes() int {
	bucketBytes := 0
	for _, held := range t.buckets {
		bucketBytes += cap(held.ordinals) * 4
	}
	return cap(t.columns)*32 + bucketBytes
}
