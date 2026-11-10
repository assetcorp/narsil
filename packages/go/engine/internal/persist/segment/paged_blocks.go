package segment

import (
	"encoding/binary"
	"math"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/paged"
)

const (
	blockSummaryMaxTermAt   = 4
	blockSummaryMinLengthAt = 6
	blockSummaryEntriesAt   = 14
	blockSummaryDocumentsAt = 18
)

type tokenRows struct {
	documents   []uint32
	frequencies []uint16
	fields      []uint16
	starts      []uint32
	positions   []uint32
}

func fieldLengthBound(columns [][]uint32, field uint16, ordinal uint32) float64 {
	if int(field) >= len(columns) || columns[field] == nil || int(ordinal) >= len(columns[field]) {
		return absentFieldLengthBound
	}
	if stored := columns[field][ordinal]; stored > 0 {
		return float64(stored)
	}
	return absentFieldLengthBound
}

type blockBound struct {
	entryEnd           uint32
	maxTermFrequency   uint16
	minFieldLength     float64
	maxRunPerDocument  uint32
	documentsInTheList uint32
}

func scanBlocks(rows *tokenRows, columns [][]uint32) []blockBound {
	var bounds []blockBound
	length := len(rows.documents)
	blockStart := 0
	current := blockBound{minFieldLength: math.Inf(1)}
	for entry := 0; entry < length; {
		document := rows.documents[entry]
		run := 0
		for entry+run < length && rows.documents[entry+run] == document {
			position := entry + run
			current.maxTermFrequency = max(current.maxTermFrequency, rows.frequencies[position])
			current.minFieldLength = min(current.minFieldLength,
				fieldLengthBound(columns, rows.fields[position], document))
			run++
		}
		current.maxRunPerDocument = max(current.maxRunPerDocument, uint32(run))
		current.documentsInTheList++
		entry += run
		if entry-blockStart >= targetBlockEntries || entry == length {
			current.entryEnd = uint32(entry)
			if math.IsInf(current.minFieldLength, 1) {
				current.minFieldLength = absentFieldLengthBound
			}
			bounds = append(bounds, current)
			blockStart = entry
			current = blockBound{minFieldLength: math.Inf(1)}
		}
	}
	return bounds
}

func appendBlockSummaries(summaries []byte, bounds []blockBound) []byte {
	for _, bound := range bounds {
		place := len(summaries)
		summaries = append(summaries, make([]byte, paged.BlockSummaryBytes)...)
		binary.LittleEndian.PutUint32(summaries[place:], bound.entryEnd)
		binary.LittleEndian.PutUint16(summaries[place+blockSummaryMaxTermAt:], bound.maxTermFrequency)
		binary.LittleEndian.PutUint64(summaries[place+blockSummaryMinLengthAt:], math.Float64bits(bound.minFieldLength))
		binary.LittleEndian.PutUint32(summaries[place+blockSummaryEntriesAt:], bound.maxRunPerDocument)
		binary.LittleEndian.PutUint32(summaries[place+blockSummaryDocumentsAt:], bound.documentsInTheList)
	}
	return summaries
}
