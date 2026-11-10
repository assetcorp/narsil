package partition

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/bitset"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/postings"
)

type keywordSource interface {
	lookup(token string) (postings.List, bool, error)
	fuzzy(token string, tolerance, prefixLength int) ([]postings.Match, error)
	fuzzyTokens(token string, tolerance, prefixLength int) []string
	documentFrequency(token string) uint32
	holdsToken(token string) bool
	pool() postings.Pool
	removedBits() bitset.Bits
	isRemoved(ordinal uint32) bool
	liveBits() bitset.Bits
	ordinalCapacity() uint32
	names() []string
	lengthColumn(field string) []uint32
	documentCount() int
	averageLength(field string) (float64, bool)
	totalLengths() map[string]float64
	documentAt(ordinal uint32) (*StoredDocument, error)
	idAt(ordinal uint32) (string, bool)
	heldDocument(ordinal uint32) *StoredDocument
	prefixSuggestions(prefix string) []postings.Suggestion
	surfaceCandidates(prefix string) []surfaceCandidate
	surfaceCount() int
	verbatimOccurrences(token string) int
}

type searcher struct {
	src keywordSource
}

func (s *side) lookup(token string) (postings.List, bool, error) {
	list, found := s.postings.Lookup(token)
	return list, found, nil
}

func (s *side) fuzzy(token string, tolerance, prefixLength int) ([]postings.Match, error) {
	return s.postings.FuzzyLookup(token, tolerance, prefixLength), nil
}

func (s *side) fuzzyTokens(token string, tolerance, prefixLength int) []string {
	matches := s.postings.FuzzyLookup(token, tolerance, prefixLength)
	tokens := make([]string, len(matches))
	for at, match := range matches {
		tokens[at] = match.Token
	}
	return tokens
}

func (s *side) documentFrequency(token string) uint32 {
	return s.postings.DocumentFrequency(token)
}

func (s *side) holdsToken(token string) bool {
	return s.postings.Has(token)
}

func (s *side) pool() postings.Pool {
	return s.postings.Pool()
}

func (s *side) removedBits() bitset.Bits {
	return s.postings.Retired()
}

func (s *side) isRemoved(ordinal uint32) bool {
	return s.postings.IsRetired(ordinal)
}

func (s *side) liveBits() bitset.Bits {
	return s.documents.live
}

func (s *side) ordinalCapacity() uint32 {
	return s.documents.capacity()
}

func (s *side) names() []string {
	return s.fieldNames
}

func (s *side) lengthColumn(field string) []uint32 {
	return s.documents.lengthColumns[field]
}

func (s *side) documentCount() int {
	return s.statistics.totalDocuments
}

func (s *side) averageLength(field string) (float64, bool) {
	return s.statistics.averageFieldLength(field)
}

func (s *side) totalLengths() map[string]float64 {
	return s.statistics.totalFieldLengths
}

func (s *side) documentAt(ordinal uint32) (*StoredDocument, error) {
	return s.documents.at(ordinal), nil
}

func (s *side) idAt(ordinal uint32) (string, bool) {
	document := s.documents.at(ordinal)
	if document == nil {
		return "", false
	}
	return document.ID, true
}

func (s *side) heldDocument(ordinal uint32) *StoredDocument {
	return s.documents.at(ordinal)
}
