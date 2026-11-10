package segment

import (
	"context"
	"encoding/binary"
	"math"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/keyword"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/paged"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type streamedLists struct {
	postings            *sectionSink
	tokenTotals         *sectionSink
	positionOffsets     *sectionSink
	positions           *sectionSink
	documentFrequencies []byte
	postingOffsets      []byte
	blockLists          []byte
	blockListOffsets    []byte
	blockSummaries      []byte
}

func (stream *pagedStream) openLists(built *keyword.Segment) (*streamedLists, error) {
	lists := &streamedLists{postingOffsets: binary.LittleEndian.AppendUint32(nil, 0),
		blockListOffsets: binary.LittleEndian.AppendUint32(nil, 0)}
	var err error
	if lists.postings, err = stream.sink("postings"); err != nil {
		return nil, err
	}
	if lists.tokenTotals, err = stream.sink("tokenTotals"); err != nil {
		return nil, err
	}
	if built.TracksPositions {
		if lists.positionOffsets, err = stream.sink("positionOffsets"); err != nil {
			return nil, err
		}
		if lists.positions, err = stream.sink("positions"); err != nil {
			return nil, err
		}
	}
	stream.removals, err = openRemovalSpill(stream.scratchPath, int(built.DocumentCount),
		int64(built.PostingDocuments.Len()))
	return lists, err
}

func (lists *streamedLists) writeRows(rows *tokenRows, positionsWritten uint32, buffer []byte) ([]byte, error) {
	buffer = buffer[:0]
	for _, document := range rows.documents {
		buffer = binary.LittleEndian.AppendUint32(buffer, document)
	}
	for _, frequency := range rows.frequencies {
		buffer = binary.LittleEndian.AppendUint16(buffer, frequency)
	}
	for _, field := range rows.fields {
		buffer = binary.LittleEndian.AppendUint16(buffer, field)
	}
	if err := lists.postings.write(buffer); err != nil {
		return buffer, err
	}
	if lists.positionOffsets == nil {
		return buffer, nil
	}
	buffer = buffer[:0]
	for at := range rows.documents {
		buffer = binary.LittleEndian.AppendUint32(buffer, positionsWritten+rows.starts[at])
	}
	if err := lists.positionOffsets.write(buffer); err != nil {
		return buffer, err
	}
	buffer = buffer[:0]
	for _, position := range rows.positions {
		buffer = binary.LittleEndian.AppendUint32(buffer, position)
	}
	return buffer, lists.positions.write(buffer)
}

func (stream *pagedStream) addRemovals(rows *tokenRows, token uint32) error {
	for at := 0; at < len(rows.documents); {
		ordinal := rows.documents[at]
		occurrences := uint32(0)
		for at < len(rows.documents) && rows.documents[at] == ordinal {
			occurrences += uint32(rows.frequencies[at])
			at++
		}
		if err := stream.removals.add(ordinal, token, occurrences); err != nil {
			return err
		}
	}
	return nil
}

func (stream *pagedStream) writeLists(ctx context.Context, built *keyword.Segment) (*streamedLists, error) {
	lists, err := stream.openLists(built)
	if err != nil {
		return nil, err
	}
	columns := lengthColumnsOf(built)
	written, positionsWritten := uint32(0), uint32(0)
	var buffer []byte
	for token := range built.TokenOffsets.Len() - 1 {
		if token%pagedWriterCancelCheckTokens == 0 {
			if err := ctx.Err(); err != nil {
				return nil, narsilerr.Wrap(narsilerr.CodePersistenceSaveFailed,
					"The paged keyword segment write was cancelled", err, nil)
			}
		}
		rows := rowsOfToken(built, token)
		if buffer, err = lists.writeRows(rows, positionsWritten, buffer); err != nil {
			return nil, err
		}
		positionsWritten += uint32(len(rows.positions))
		var total [8]byte
		binary.LittleEndian.PutUint64(total[:], math.Float64bits(rows.occurrences()))
		if err := lists.tokenTotals.write(total[:]); err != nil {
			return nil, err
		}
		lists.documentFrequencies = binary.LittleEndian.AppendUint32(lists.documentFrequencies, rows.distinctDocuments())
		if len(rows.documents) > paged.SmallestBlockPostings {
			lists.blockLists = binary.LittleEndian.AppendUint32(lists.blockLists, uint32(token))
			lists.blockSummaries = appendBlockSummaries(lists.blockSummaries, scanBlocks(rows, columns))
			lists.blockListOffsets = binary.LittleEndian.AppendUint32(lists.blockListOffsets,
				uint32(len(lists.blockSummaries)/paged.BlockSummaryBytes))
		}
		if err := stream.addRemovals(rows, uint32(token)); err != nil {
			return nil, err
		}
		written += uint32(len(rows.documents))
		lists.postingOffsets = binary.LittleEndian.AppendUint32(lists.postingOffsets, written)
	}
	if lists.positionOffsets != nil {
		if err := lists.positionOffsets.write(binary.LittleEndian.AppendUint32(nil, positionsWritten)); err != nil {
			return nil, err
		}
	}
	return lists, nil
}
