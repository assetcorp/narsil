package fieldindex

import (
	"cmp"
	"slices"
	"strings"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/bitset"
)

type EnumCount struct {
	Value string
	Count int
}

type affixEntry struct {
	key  string
	slot uint32
}

type enumAffixes struct {
	forward  []affixEntry
	backward []affixEntry
}

type arrayIndexKey struct {
	index uint32
	slot  uint32
}

const maxArrayIndex = 1<<32 - 2

func (index *Enum) EqualInto(value string, into bitset.Bits) {
	if slot, held := index.slots[value]; held {
		index.postings[slot].order.setInto(into)
	}
}

func (index *Enum) AnyInto(values []string, into bitset.Bits) {
	for _, value := range values {
		index.EqualInto(value, into)
	}
}

func (index *Enum) PrefixInto(prefix string, into bitset.Bits) {
	index.setMatching(index.currentAffixes().forward, prefix, into)
}

func (index *Enum) SuffixInto(suffix string, into bitset.Bits) {
	index.setMatching(index.currentAffixes().backward, reversedBytes(suffix), into)
}

func (index *Enum) AllInto(into bitset.Bits) {
	for _, slot := range index.valueOrder.ordinals {
		if slot != vacantOrdinal {
			index.postings[slot].order.setInto(into)
		}
	}
}

func (index *Enum) Counts(matched bitset.Bits) []EnumCount {
	var counts []EnumCount
	for _, slot := range index.valueOrder.ordinals {
		if slot == vacantOrdinal {
			continue
		}
		posting := &index.postings[slot]
		if count := posting.order.countMatched(matched); count > 0 {
			counts = append(counts, EnumCount{Value: posting.value, Count: count})
		}
	}
	return counts
}

func (index *Enum) Postings() []EnumPosting {
	var indexKeys []arrayIndexKey
	var otherKeys []uint32
	for _, slot := range index.valueOrder.ordinals {
		if slot == vacantOrdinal {
			continue
		}
		if keyIndex, isIndex := arrayIndexOf(index.postings[slot].value); isIndex {
			indexKeys = append(indexKeys, arrayIndexKey{index: keyIndex, slot: slot})
		} else {
			otherKeys = append(otherKeys, slot)
		}
	}
	slices.SortFunc(indexKeys, func(left, right arrayIndexKey) int { return cmp.Compare(left.index, right.index) })
	postings := make([]EnumPosting, 0, len(indexKeys)+len(otherKeys))
	for _, key := range indexKeys {
		postings = append(postings, index.exportedPosting(key.slot))
	}
	for _, slot := range otherKeys {
		postings = append(postings, index.exportedPosting(slot))
	}
	return postings
}

func (index *Enum) exportedPosting(slot uint32) EnumPosting {
	posting := &index.postings[slot]
	return EnumPosting{Value: posting.value, Ordinals: posting.order.appendLive(make([]uint32, 0, posting.order.live))}
}

func (index *Enum) currentAffixes() *enumAffixes {
	if built := index.affixes.Load(); built != nil {
		return built
	}
	built := index.builtAffixes()
	index.affixes.CompareAndSwap(nil, built)
	return built
}

func (index *Enum) builtAffixes() *enumAffixes {
	built := &enumAffixes{
		forward:  make([]affixEntry, 0, index.valueOrder.live),
		backward: make([]affixEntry, 0, index.valueOrder.live),
	}
	for _, slot := range index.valueOrder.ordinals {
		if slot == vacantOrdinal {
			continue
		}
		value := index.postings[slot].value
		built.forward = append(built.forward, affixEntry{key: value, slot: slot})
		built.backward = append(built.backward, affixEntry{key: reversedBytes(value), slot: slot})
	}
	slices.SortFunc(built.forward, compareAffixKeys)
	slices.SortFunc(built.backward, compareAffixKeys)
	return built
}

func compareAffixKeys(left, right affixEntry) int {
	return strings.Compare(left.key, right.key)
}

func (index *Enum) setMatching(entries []affixEntry, start string, into bitset.Bits) {
	first, _ := slices.BinarySearchFunc(entries, start, func(entry affixEntry, target string) int {
		return strings.Compare(entry.key, target)
	})
	for at := first; at < len(entries) && strings.HasPrefix(entries[at].key, start); at++ {
		index.postings[entries[at].slot].order.setInto(into)
	}
}

func reversedBytes(value string) string {
	reversed := make([]byte, len(value))
	for at := 0; at < len(value); at++ {
		reversed[len(value)-1-at] = value[at]
	}
	return string(reversed)
}

func arrayIndexOf(value string) (uint32, bool) {
	if value == "" || len(value) > 10 || (value[0] == '0' && len(value) > 1) {
		return 0, false
	}
	var parsed uint64
	for at := 0; at < len(value); at++ {
		digit := value[at]
		if digit < '0' || digit > '9' {
			return 0, false
		}
		parsed = parsed*10 + uint64(digit-'0')
	}
	if parsed > maxArrayIndex {
		return 0, false
	}
	return uint32(parsed), true
}
