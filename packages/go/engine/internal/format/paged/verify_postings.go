package paged

import (
	"math"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/keyword"
)

type blockTally struct {
	maxFrequency uint16
	minLength    float64
	maxEntries   uint32
	documents    uint32
}

func freshBlockTally() blockTally {
	return blockTally{minLength: math.Inf(1)}
}

func (tally blockTally) matches(summary BlockSummary, end int) bool {
	return int(summary.PostingEnd) == end && summary.MaxTermFrequency == tally.maxFrequency &&
		summary.MinFieldLength == tally.minLength && summary.MaxEntriesPerDocument == tally.maxEntries &&
		summary.DocumentCount == tally.documents
}

func (reader *Reader) lengthColumnsByField() []keyword.Uint32s {
	columns := make([]keyword.Uint32s, len(reader.Head.FieldNames))
	for at, field := range reader.Head.FieldNames {
		for _, column := range reader.Resident.FieldLengths {
			if column.Field == field {
				columns[at] = column.Lengths
				break
			}
		}
	}
	return columns
}

func lengthOf(columns []keyword.Uint32s, field int, document uint32) float64 {
	if field >= len(columns) || int(document) >= columns[field].Len() {
		return 0
	}
	return float64(columns[field].At(int(document)))
}

func (reader *Reader) requirePostings() error {
	columns := reader.lengthColumnsByField()
	for token := range reader.TokenCount() {
		if err := reader.requireTokenPostings(token, columns); err != nil {
			return err
		}
	}
	return nil
}

func (reader *Reader) requireTokenPostings(token int, columns []keyword.Uint32s) error {
	list, err := reader.PostingList(token)
	if err != nil {
		return err
	}
	if _, _, err := reader.Positions(token); err != nil {
		return err
	}
	blocks, summarised, err := reader.BlockBounds(token)
	if err != nil {
		return err
	}
	rows := list.Documents.Len()
	if (rows > SmallestBlockPostings) != summarised {
		return loadFailed("The block summaries of token "+itoaInt(token)+" of the "+what+" do not cover its postings",
			map[string]any{"token": token})
	}
	var documents uint32
	var occurrences float64
	block, start, row := 0, 0, 0
	tally := freshBlockTally()
	for row < rows {
		document := list.Documents.At(row)
		var entries uint32
		for row < rows && (entries == 0 || list.Documents.At(row) == document) {
			frequency := list.Frequencies.At(row)
			occurrences += float64(frequency)
			tally.maxFrequency = max(tally.maxFrequency, frequency)
			tally.minLength = min(tally.minLength, lengthOf(columns, int(list.Fields.At(row)), document))
			row++
			entries++
		}
		documents++
		tally.documents++
		tally.maxEntries = max(tally.maxEntries, entries)
		if !summarised || (row-start < SmallestBlockPostings && row < rows) {
			continue
		}
		if block >= len(blocks) || !tally.matches(blocks[block], row) {
			return loadFailed("Block "+itoaInt(block)+" of token "+itoaInt(token)+" of the "+what+
				" differs from its postings", map[string]any{"token": token, "block": block})
		}
		block++
		start = row
		tally = freshBlockTally()
	}
	total, err := reader.TokenTotal(token)
	if err != nil {
		return err
	}
	if documents != reader.Resident.DocumentFrequencies.At(token) || occurrences != total {
		return loadFailed("The counts of token "+itoaInt(token)+" of the "+what+" differ from its postings",
			map[string]any{"token": token})
	}
	return nil
}
