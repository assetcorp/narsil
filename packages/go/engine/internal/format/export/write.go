package export

import (
	"io"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type Writer struct {
	destination io.Writer
	line        []byte
	failure     error
}

type ChangePositions struct {
	Epoch      string
	LastSeqNos []uint64
}

func headerValue(index any, positions *ChangePositions) codec.OrderedMap {
	header := codec.OrderedMap{
		{Key: headerFormatKey, Value: FormatName},
		{Key: headerVersionKey, Value: float64(FormatVersion)},
		{Key: headerIndexKey, Value: index},
	}
	if positions == nil {
		return header
	}
	listed := make([]any, len(positions.LastSeqNos))
	for partitionID, seqNo := range positions.LastSeqNos {
		listed[partitionID] = codec.OrderedMap{{Key: positionPartitionKey, Value: float64(partitionID)},
			{Key: positionSeqNoKey, Value: float64(seqNo)}}
	}
	return append(header, codec.MapEntry{Key: headerEpochKey, Value: positions.Epoch},
		codec.MapEntry{Key: headerPositionsKey, Value: listed})
}

func NewWriter(destination io.Writer, header Header) (*Writer, error) {
	if header.Index == nil {
		return nil, narsilerr.New(narsilerr.CodeConfigInvalid, "The document export header holds no index configuration", nil)
	}
	return newWriter(destination, header.Index, nil)
}

func NewWriterInStoredOrder(destination io.Writer, index codec.OrderedMap, positions *ChangePositions) (*Writer,
	error) {
	if index == nil {
		return nil, narsilerr.New(narsilerr.CodeConfigInvalid, "The document export header holds no index configuration", nil)
	}
	return newWriter(destination, index, positions)
}

func newWriter(destination io.Writer, index any, positions *ChangePositions) (*Writer, error) {
	writer := &Writer{destination: destination}
	line, err := codec.AppendExactJSON(nil, headerValue(index, positions), "")
	if err != nil {
		return nil, err
	}
	if err := writer.writeLine(line); err != nil {
		return nil, err
	}
	return writer, nil
}

func (writer *Writer) writeLine(line []byte) error {
	if len(line) > MaxLineBytes {
		return narsilerr.New(narsilerr.CodeDocValidationFailed,
			"The export line takes "+strconv.Itoa(len(line))+" bytes, above the line limit of "+strconv.Itoa(MaxLineBytes),
			map[string]any{"bytes": len(line), "maximum": MaxLineBytes})
	}
	line = append(line, '\n')
	if _, err := writer.destination.Write(line); err != nil {
		writer.failure = narsilerr.Wrap(narsilerr.CodePersistenceSaveFailed, "The document export fails to write", err, nil)
		return writer.failure
	}
	return nil
}

func (writer *Writer) WriteDocument(id string, document map[string]any) error {
	if writer.failure != nil {
		return writer.failure
	}
	withID := document
	if existing, ok := document[documentIDKey].(string); !ok || existing != id {
		withID = make(map[string]any, len(document)+1)
		for key, value := range document {
			withID[key] = value
		}
		withID[documentIDKey] = id
	}
	return writer.writeDocumentLine(withID, id)
}

func (writer *Writer) WriteStoredDocument(id string, stored codec.OrderedMap) error {
	if writer.failure != nil {
		return writer.failure
	}
	withID := make(codec.OrderedMap, 1, len(stored)+1)
	withID[0] = codec.MapEntry{Key: documentIDKey, Value: id}
	for _, entry := range stored {
		if entry.Key != documentIDKey {
			withID = append(withID, entry)
		}
	}
	return writer.writeDocumentLine(codec.InJavaScriptPropertyOrder(withID), id)
}

func (writer *Writer) writeDocumentLine(document any, id string) error {
	line, err := codec.AppendDocumentJSON(writer.line[:0], document, id)
	if err != nil {
		return err
	}
	writer.line = line
	return writer.writeLine(line)
}
