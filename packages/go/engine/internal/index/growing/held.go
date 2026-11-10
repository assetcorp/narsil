package growing

import "github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"

type ordinalSet struct {
	words []uint32
}

func (o *ordinalSet) grow(capacity uint64) {
	words := retiredWords(capacity)
	if words > uint64(len(o.words)) {
		o.words = append(o.words, make([]uint32, words-uint64(len(o.words)))...)
	}
}

func (o *ordinalSet) has(ordinal uint32) bool {
	word := uint64(ordinal >> 5)
	return word < uint64(len(o.words)) && o.words[word]&(1<<(ordinal&31)) != 0
}

func (o *ordinalSet) set(ordinal uint32) {
	o.words[ordinal>>5] |= 1 << (ordinal & 31)
}

func (o *ordinalSet) clear(ordinal uint32) {
	if o.has(ordinal) {
		o.words[ordinal>>5] &^= 1 << (ordinal & 31)
	}
}

func (s *Segment) ordinalRetired(ordinal uint32) bool {
	word := uint64(ordinal >> 5)
	return uint64(ordinal) < s.fields.ordinalCapacity && word < s.retired.len() &&
		s.retired.values[word]&(1<<(ordinal&31)) != 0
}

func retiredRefusal(ordinal uint32) error {
	return narsilerr.New(narsilerr.CodePartitionCorrupted,
		"The growing keyword segment keeps this ordinal retired until a vacuum purges its postings",
		map[string]any{"ordinal": float64(ordinal)})
}

func heldRefusal(ordinal uint32, held bool) error {
	message := "The growing keyword segment holds no document at this ordinal"
	if held {
		message = "The growing keyword segment already holds a document at this ordinal"
	}
	return narsilerr.New(narsilerr.CodePartitionCorrupted, message, map[string]any{"ordinal": float64(ordinal)})
}
