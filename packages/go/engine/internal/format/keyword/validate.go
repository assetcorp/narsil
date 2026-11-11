package keyword

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/form"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

func (segment *Segment) Validate() error {
	flat := make(map[string]any, len(segment.Schema))
	for path, fieldType := range segment.Schema {
		flat[path] = fieldType
	}
	if err := schema.RequireValidFieldTypes(flat); err != nil {
		return err
	}
	if len(segment.FieldNames) > MaxFieldNames {
		return narsilerr.New(narsilerr.CodePersistenceLoadFailed,
			corruptPrefix+"fieldNames holds more names than the limit of "+itoa(MaxFieldNames), nil)
	}
	if !segment.TracksPositions && (segment.PositionOffsets != nil || segment.Positions != nil) {
		return narsilerr.New(narsilerr.CodePersistenceLoadFailed,
			corruptPrefix+"positionOffsets and positions are set on a segment that tracks no positions", nil)
	}
	return segment.check(NewChecker(corruptPrefix))
}

func (segment *Segment) check(checker *Checker) error {
	segment.checkPostings(checker)
	segment.checkIDs(checker)
	segment.checkDocuments(checker)
	documentCount := segment.DocumentCount
	checker.CheckFieldLengths(segment.FieldLengths, documentCount)
	checker.CheckValueColumns(segment.Numeric, "numeric", documentCount)
	checker.CheckValueColumns(segment.Sizes, "sizes", documentCount)
	checker.CheckBooleanColumns(segment.Boolean, documentCount)
	checker.CheckEnumColumns(segment.Enum, documentCount)
	checker.CheckGeopointColumns(segment.Geopoint, documentCount)
	checker.CheckPatternColumns(segment.Pattern, documentCount)
	checker.CheckSurfaceForms(segment.SurfaceForms)
	checker.CheckPartialWords(segment.PartialWords, segment.TokenOffsets.Len()-1)
	segment.checkWriteRecords(checker)
	return checker.Err()
}

func (checker *Checker) TokenColumns(tokens []byte, offsets Uint32s) {
	checker.Width(offsets, Uint32Bytes, "tokenOffsets")
	checker.Offsets(offsets, len(tokens), "tokenOffsets")
	checker.UTF8Entries(tokens, offsets, "tokens")
	checker.EntriesAscend(tokens, offsets, nil, "tokens")
}

func (checker *Checker) DocumentFrequencies(frequencies Uint32s, postingOffsets Uint32s) {
	if checker.err != nil {
		return
	}
	for token := range frequencies.Len() {
		postings := postingOffsets.At(token+1) - postingOffsets.At(token)
		frequency := frequencies.At(token)
		if frequency == 0 || frequency > postings {
			checker.Fail("documentFrequencies gives token "+itoa(token)+" a count of "+itoa(int(frequency))+
				" over "+itoa(int(postings))+" postings", map[string]any{"token": token})
			return
		}
	}
}

func (segment *Segment) checkPostings(checker *Checker) {
	checker.TokenColumns(segment.Tokens, segment.TokenOffsets)
	if checker.Failed() {
		return
	}
	tokens := segment.TokenOffsets.Len() - 1
	checker.Width(segment.DocumentFrequencies, Uint32Bytes, "documentFrequencies")
	checker.Width(segment.PostingOffsets, Uint32Bytes, "postingOffsets")
	checker.Width(segment.PostingDocuments, Uint32Bytes, "postingDocuments")
	checker.Width(segment.PostingFrequencies, Uint16Bytes, "postingFrequencies")
	checker.Width(segment.PostingFields, Uint16Bytes, "postingFields")
	postings := segment.PostingDocuments.Len()
	checker.Count(segment.DocumentFrequencies.Len(), tokens, "documentFrequencies")
	checker.Count(segment.PostingOffsets.Len(), tokens+1, "postingOffsets")
	checker.Offsets(segment.PostingOffsets, postings, "postingOffsets")
	checker.Count(segment.PostingFrequencies.Len(), postings, "postingFrequencies")
	checker.Count(segment.PostingFields.Len(), postings, "postingFields")
	checker.Ordinals(segment.PostingDocuments, segment.DocumentCount, "postingDocuments")
	fieldNames := uint32(len(segment.FieldNames))
	if !checker.Failed() {
		for at := range segment.PostingFields.Len() {
			if uint32(segment.PostingFields.At(at)) >= fieldNames {
				checker.Fail("postingFields names field "+itoa(int(segment.PostingFields.At(at)))+" of "+
					itoa(int(fieldNames)), map[string]any{"at": at})
				break
			}
		}
	}
	checker.DocumentFrequencies(segment.DocumentFrequencies, segment.PostingOffsets)
	if !segment.TracksPositions {
		return
	}
	checker.Width(segment.PositionOffsets, Uint32Bytes, "positionOffsets")
	checker.Width(segment.Positions, Uint32Bytes, "positions")
	checker.Count(segment.PositionOffsets.Len(), postings+1, "positionOffsets")
	checker.Offsets(segment.PositionOffsets, segment.Positions.Len(), "positionOffsets")
}

func (segment *Segment) checkIDs(checker *Checker) {
	count := int(segment.DocumentCount)
	checker.Width(segment.IDOffsets, Uint32Bytes, "idOffsets")
	checker.Width(segment.IDOrder, Uint32Bytes, "idOrder")
	checker.Count(segment.IDOffsets.Len(), count+1, "idOffsets")
	checker.Count(segment.IDOrder.Len(), count, "idOrder")
	checker.Offsets(segment.IDOffsets, len(segment.IDs), "idOffsets")
	checker.UTF8Entries(segment.IDs, segment.IDOffsets, "ids")
	checker.Permutation(segment.IDOrder, "idOrder")
	checker.EntriesAscend(segment.IDs, segment.IDOffsets, segment.IDOrder, "ids")
}

func (segment *Segment) checkDocuments(checker *Checker) {
	checker.Width(segment.DocumentOffsets, Uint32Bytes, "documentOffsets")
	checker.Count(segment.DocumentOffsets.Len(), int(segment.DocumentCount)+1, "documentOffsets")
	checker.Offsets(segment.DocumentOffsets, len(segment.Documents), "documentOffsets")
}

func (checker *Checker) WriteRecords(seqNos Uint64s, primaryTerms Uint64s, documentCount uint32) {
	checker.Width(seqNos, Uint64Bytes, "seqNos")
	checker.Width(primaryTerms, Uint64Bytes, "primaryTerms")
	if checker.err != nil {
		return
	}
	for _, values := range []struct {
		list Uint64s
		name string
	}{{seqNos, "seqNos"}, {primaryTerms, "primaryTerms"}} {
		for at := range values.list.Len() {
			if values.list.At(at) > form.MaxSafeInteger {
				checker.Fail(values.name+" holds a value above 2^53 - 1", map[string]any{"at": at})
				return
			}
		}
	}
	checker.Count(seqNos.Len(), int(documentCount), "seqNos")
	checker.Count(primaryTerms.Len(), int(documentCount), "primaryTerms")
	if checker.err != nil {
		return
	}
	for at := range int(documentCount) {
		if seqNos.At(at) == 0 && primaryTerms.At(at) != 0 {
			checker.Fail("primaryTerms gives document "+itoa(at)+" a term without a seqNo", map[string]any{"at": at})
			return
		}
	}
}

func (segment *Segment) checkWriteRecords(checker *Checker) {
	if segment.HasWriteRecords {
		checker.WriteRecords(segment.SeqNos, segment.PrimaryTerms, segment.DocumentCount)
	}
}
