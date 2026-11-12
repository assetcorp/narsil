package wal

import (
	"math"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/form"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type Segment struct {
	FormatVersion uint8
	Entries       []Entry
}

func DecodeSegment(data []byte) (Segment, error) {
	version, err := CheckSegmentHeader(data)
	if err != nil {
		return Segment{}, err
	}
	entries, err := ReadDurableRegion(data, uint64(len(data)))
	if err != nil {
		return Segment{}, err
	}
	return Segment{FormatVersion: version, Entries: entries}, nil
}

func EncodeSegment(segment Segment) ([]byte, error) {
	encoded := AppendSegmentHeader(nil)
	encoded[formatVersionOffset] = segment.FormatVersion
	var err error
	for _, entry := range segment.Entries {
		if encoded, err = AppendRecord(encoded, entry); err != nil {
			return nil, err
		}
	}
	return encoded, nil
}

func (segment Segment) JSONValue() (map[string]any, error) {
	records := make([]any, len(segment.Entries))
	for index, entry := range segment.Entries {
		record := map[string]any{
			"seqNo":       float64(entry.SeqNo),
			"primaryTerm": float64(entry.PrimaryTerm),
			"operation":   string(entry.Operation),
			"partitionId": float64(entry.PartitionID),
			"indexName":   entry.IndexName,
			"documentId":  entry.DocumentID,
		}
		if entry.Document != nil {
			document, err := codec.Unmarshal(entry.Document, codec.DecodeOptions{
				ErrorCode: narsilerr.CodePersistenceWalCorrupt,
			})
			if err != nil {
				return nil, err
			}
			record["document"] = document
		}
		switch entry.Previous {
		case PreviousDocumentNone:
			record[previousDocumentKey] = nil
		case PreviousDocumentHeld:
			previous, err := codec.Unmarshal(entry.PreviousDocument, codec.DecodeOptions{
				ErrorCode: narsilerr.CodePersistenceWalCorrupt,
			})
			if err != nil {
				return nil, err
			}
			record[previousDocumentKey] = previous
		}
		records[index] = record
	}
	return map[string]any{"walFormatVersion": float64(segment.FormatVersion), "records": records}, nil
}

func SegmentFromJSON(value map[string]any) (Segment, error) {
	fields := form.NewFields(value, "", form.CodeJSONForm, "log segment JSON form")
	segment := Segment{FormatVersion: uint8(fields.Uint("walFormatVersion", math.MaxUint8))}
	records := fields.List("records")
	if fields.Err() != nil {
		return Segment{}, fields.Err()
	}
	segment.Entries = make([]Entry, 0, len(records))
	for index := range records {
		record := fields.Element(records, "records", index)
		entry := Entry{
			SeqNo:       record.Uint("seqNo", form.MaxSafeInteger),
			PrimaryTerm: record.Uint("primaryTerm", form.MaxSafeInteger),
			Operation:   Operation(record.String("operation")),
			PartitionID: uint32(record.Uint("partitionId", math.MaxUint32)),
			IndexName:   record.String("indexName"),
			DocumentID:  record.String("documentId"),
		}
		if record.HasValue("document") {
			body, isMap := record.Value("document").(map[string]any)
			if !isMap {
				return Segment{}, narsilerr.New(form.CodeJSONForm,
					"The log segment JSON form holds record "+strconv.Itoa(index)+" whose document is not an object", nil)
			}
			document, err := codec.EncodeDocument(body)
			if err != nil {
				return Segment{}, narsilerr.Wrap(form.CodeJSONForm,
					"The log segment JSON form holds record "+strconv.Itoa(index)+" whose document fails to encode",
					err, nil)
			}
			entry.Document = document
		}
		if err := readPreviousDocumentForm(record, index, &entry); err != nil {
			return Segment{}, err
		}
		if fields.Err() != nil {
			return Segment{}, fields.Err()
		}
		segment.Entries = append(segment.Entries, Build(entry))
	}
	return segment, nil
}

func readPreviousDocumentForm(record *form.Fields, index int, entry *Entry) error {
	if !record.Has(previousDocumentKey) {
		return nil
	}
	raw := record.Value(previousDocumentKey)
	if raw == nil {
		entry.Previous = PreviousDocumentNone
		return nil
	}
	body, isMap := raw.(map[string]any)
	if !isMap {
		return narsilerr.New(form.CodeJSONForm,
			"The log segment JSON form holds record "+strconv.Itoa(index)+" whose previousDocument is not an object or null", nil)
	}
	previous, err := codec.EncodeDocument(body)
	if err != nil {
		return narsilerr.Wrap(form.CodeJSONForm,
			"The log segment JSON form holds record "+strconv.Itoa(index)+" whose previousDocument fails to encode", err, nil)
	}
	entry.Previous, entry.PreviousDocument = PreviousDocumentHeld, previous
	return nil
}
