package paged

import (
	"encoding/binary"
	"math"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/keyword"
)

type PostingList struct {
	Documents   keyword.Uint32s
	Frequencies keyword.Uint16s
	Fields      keyword.Uint16s
}

type PositionList struct {
	Offsets keyword.Uint32s
	Values  keyword.Uint32s
	first   uint32
}

func itoaInt(value int) string {
	return strconv.Itoa(value)
}

func (list PositionList) Row(row int) keyword.Uint32s {
	from := list.Offsets.At(row) - list.first
	to := list.Offsets.At(row+1) - list.first
	return list.Values[from*keyword.Uint32Bytes : to*keyword.Uint32Bytes]
}

func (reader *Reader) TokenCount() int {
	return reader.Resident.TokenOffsets.Len() - 1
}

func (reader *Reader) requireToken(token int) error {
	if token < 0 || token >= reader.TokenCount() {
		return loadFailed("Token "+itoaInt(token)+" lies outside the "+what, map[string]any{"token": token})
	}
	return nil
}

func (reader *Reader) postingSpan(token int) (int64, int64) {
	offsets := reader.Resident.PostingOffsets
	start := int64(offsets.At(token))
	return start, int64(offsets.At(token+1)) - start
}

func (reader *Reader) PostingList(token int) (PostingList, error) {
	if err := reader.requireToken(token); err != nil {
		return PostingList{}, err
	}
	section, err := reader.Section("postings")
	if err != nil {
		return PostingList{}, err
	}
	start, count := reader.postingSpan(token)
	bytes, err := reader.ReadSection(section, start*PostingWidthBytes, count*PostingWidthBytes)
	if err != nil {
		return PostingList{}, err
	}
	list := PostingList{
		Documents:   bytes[:count*4],
		Frequencies: bytes[count*4 : count*6],
		Fields:      bytes[count*6:],
	}
	return list, reader.requireListRules(list, token)
}

func (reader *Reader) requireListRules(list PostingList, token int) error {
	documents := reader.Head.DocumentCount
	fields := uint32(len(reader.Head.FieldNames))
	for row := range list.Documents.Len() {
		document := list.Documents.At(row)
		field := uint32(list.Fields.At(row))
		if document >= documents {
			return loadFailed("Token "+itoaInt(token)+" of the "+what+" names a document past its count",
				map[string]any{"token": token, "row": row})
		}
		if field >= fields {
			return loadFailed("Token "+itoaInt(token)+" of the "+what+" names a field past its field names",
				map[string]any{"token": token, "row": row})
		}
		if row == 0 {
			continue
		}
		before := list.Documents.At(row - 1)
		if document < before || (document == before && field <= uint32(list.Fields.At(row-1))) {
			return loadFailed("The list of token "+itoaInt(token)+" of the "+what+" descends at posting "+itoaInt(row),
				map[string]any{"token": token, "row": row})
		}
	}
	return nil
}

func (reader *Reader) Positions(token int) (PositionList, bool, error) {
	if !reader.Resident.TracksPositions {
		return PositionList{}, false, nil
	}
	if err := reader.requireToken(token); err != nil {
		return PositionList{}, false, err
	}
	offsetsSection, err := reader.Section("positionOffsets")
	if err != nil {
		return PositionList{}, false, err
	}
	valuesSection, err := reader.Section("positions")
	if err != nil {
		return PositionList{}, false, err
	}
	start, count := reader.postingSpan(token)
	offsets, err := reader.ReadSection(offsetsSection, start*PositionWidthBytes, (count+1)*PositionWidthBytes)
	if err != nil {
		return PositionList{}, false, err
	}
	list := PositionList{Offsets: offsets}
	first := list.Offsets.At(0)
	end := list.Offsets.At(int(count))
	for row := 0; row <= int(count); row++ {
		value := list.Offsets.At(row)
		if value < first || value > end || (row > 0 && value < list.Offsets.At(row-1)) {
			return PositionList{}, false, loadFailed("The position offsets of token "+itoaInt(token)+" of the "+what+
				" leave their list", map[string]any{"token": token, "row": row})
		}
	}
	list.first = first
	list.Values, err = reader.ReadSection(valuesSection, int64(first)*PositionWidthBytes,
		int64(end-first)*PositionWidthBytes)
	if err != nil {
		return PositionList{}, false, err
	}
	return list, true, nil
}

func (reader *Reader) TokenTotal(token int) (float64, error) {
	if err := reader.requireToken(token); err != nil {
		return 0, err
	}
	section, err := reader.Section("tokenTotals")
	if err != nil {
		return 0, err
	}
	bytes, err := reader.ReadSection(section, int64(token)*8, 8)
	if err != nil {
		return 0, err
	}
	return math.Float64frombits(binary.LittleEndian.Uint64(bytes)), nil
}

type BlockSummary struct {
	PostingEnd            uint32
	MaxTermFrequency      uint16
	MinFieldLength        float64
	MaxEntriesPerDocument uint32
	DocumentCount         uint32
}

func BlockSummaryAt(summaries []byte, index int) BlockSummary {
	place := summaries[index*BlockSummaryBytes:]
	return BlockSummary{
		PostingEnd:            binary.LittleEndian.Uint32(place),
		MaxTermFrequency:      binary.LittleEndian.Uint16(place[blockSummaryMaxTermOffset:]),
		MinFieldLength:        math.Float64frombits(binary.LittleEndian.Uint64(place[blockSummaryMinLengthAt:])),
		MaxEntriesPerDocument: binary.LittleEndian.Uint32(place[blockSummaryEntriesAt:]),
		DocumentCount:         binary.LittleEndian.Uint32(place[blockSummaryDocumentsAt:]),
	}
}

func (reader *Reader) BlockBounds(token int) ([]BlockSummary, bool, error) {
	resident := &reader.Resident
	lists := resident.BlockLists
	low, high := 0, lists.Len()
	for low < high {
		middle := (low + high) / 2
		if int(lists.At(middle)) < token {
			low = middle + 1
		} else {
			high = middle
		}
	}
	if low >= lists.Len() || int(lists.At(low)) != token {
		return nil, false, nil
	}
	first := int(resident.BlockListOffsets.At(low))
	blockCount := int(resident.BlockListOffsets.At(low+1)) - first
	_, length := reader.postingSpan(token)
	blocks := make([]BlockSummary, blockCount)
	before := uint32(0)
	for block := range blockCount {
		blocks[block] = BlockSummaryAt(resident.BlockSummaries, first+block)
		end := blocks[block].PostingEnd
		if end <= before || int64(end) > length {
			return nil, false, loadFailed("Block "+itoaInt(block)+" of token "+itoaInt(token)+" of the "+what+
				" ends outside its list", map[string]any{"token": token, "block": block})
		}
		before = end
	}
	if blockCount == 0 || int64(blocks[blockCount-1].PostingEnd) != length {
		return nil, false, loadFailed("The blocks of token "+itoaInt(token)+" of the "+what+" fail to cover its list",
			map[string]any{"token": token})
	}
	return blocks, true, nil
}
