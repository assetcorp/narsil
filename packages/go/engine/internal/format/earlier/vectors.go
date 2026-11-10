package earlier

import (
	"encoding/binary"
	"math"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

const (
	VectorIndexPayloadVersion = 3
	float32Bytes              = 4
	osqRecordTrailerBytes     = 16
	bitsPerByte               = 8
)

type VectorIndexCodes struct {
	Bits     uint8
	Centroid []float64
	Records  []byte
}

type VectorIndexPart struct {
	FieldName string
	Dimension uint32
	Part      uint32
	Parts     uint32
	DocIDs    []string
	Graphs    []any
	Codes     model.Optional[VectorIndexCodes]
	Vectors   []byte
}

func (part VectorIndexPart) Vector(position int) []float64 {
	if position < 0 || position >= len(part.DocIDs) {
		return nil
	}
	dimension := int(part.Dimension)
	base := position * dimension * float32Bytes
	if base+dimension*float32Bytes > len(part.Vectors) {
		return nil
	}
	values := make([]float64, dimension)
	for component := range values {
		bits := binary.LittleEndian.Uint32(part.Vectors[base+component*float32Bytes:])
		values[component] = float64(math.Float32frombits(bits))
	}
	return values
}

func invalidVectorPayload(message string, details map[string]any) error {
	return narsilerr.New(narsilerr.CodePersistenceLoadFailed, "Invalid vector index payload: "+message, details)
}

func DecodeVectorIndexParts(raw any) ([]VectorIndexPart, error) {
	list, isList := raw.([]any)
	if !isList {
		return nil, invalidVectorPayload("a field must carry a list of parts", nil)
	}
	parts := make([]VectorIndexPart, 0, len(list))
	for _, element := range list {
		part, err := decodeVectorIndexPart(element)
		if err != nil {
			return nil, err
		}
		parts = append(parts, part)
	}
	return parts, nil
}

func positiveCount(value any, maximum uint64) (uint32, bool) {
	count, valid := safeUint(value, maximum)
	return uint32(count), valid
}

func decodeVectorIndexPart(raw any) (VectorIndexPart, error) {
	record, isMap := raw.(map[string]any)
	if !isMap {
		return VectorIndexPart{}, invalidVectorPayload("payload must be a map", nil)
	}
	if version, _ := record["v"].(float64); version != VectorIndexPayloadVersion {
		return VectorIndexPart{}, narsilerr.New(narsilerr.CodeEnvelopeVersionMismatch,
			"This vector index payload was written in a layout other than "+strconv.Itoa(VectorIndexPayloadVersion)+
				", and this build reads that layout alone", map[string]any{"version": record["v"]})
	}
	part := VectorIndexPart{}
	var valid bool
	if part.FieldName, valid = record["fieldName"].(string); !valid {
		return VectorIndexPart{}, invalidVectorPayload("fieldName must be a string", nil)
	}
	if part.Dimension, valid = positiveCount(record["dimension"], math.MaxUint32); !valid || part.Dimension == 0 {
		return VectorIndexPart{}, invalidVectorPayload("dimension must be a positive integer", nil)
	}
	if part.Part, valid = positiveCount(record["part"], math.MaxUint32); !valid {
		return VectorIndexPart{}, invalidVectorPayload("part must be a non-negative integer", nil)
	}
	if part.Parts, valid = positiveCount(record["parts"], math.MaxUint32); !valid || part.Parts == 0 || part.Part >= part.Parts {
		return VectorIndexPart{}, invalidVectorPayload("parts must exceed part", nil)
	}
	docIDs, isList := record["docIds"].([]any)
	if !isList {
		return VectorIndexPart{}, invalidVectorPayload("docIds must be a list of strings", nil)
	}
	if len(docIDs) > MaxVectorIndexPartVectors {
		return VectorIndexPart{}, invalidVectorPayload("a part holds at most "+strconv.Itoa(MaxVectorIndexPartVectors)+
			" vectors", map[string]any{"count": len(docIDs)})
	}
	part.DocIDs = make([]string, len(docIDs))
	for index, element := range docIDs {
		if part.DocIDs[index], valid = element.(string); !valid {
			return VectorIndexPart{}, invalidVectorPayload("docIds must be a list of strings", nil)
		}
	}
	if part.Graphs, valid = record["graphs"].([]any); !valid || !allGraphs(part.Graphs) {
		return VectorIndexPart{}, invalidVectorPayload("graphs must be a list of graphs, each holding a list of nodes", nil)
	}
	if part.Vectors, valid = record["vectors"].([]byte); !valid {
		return VectorIndexPart{}, invalidVectorPayload("vectors must be bytes", nil)
	}
	if uint64(len(part.Vectors)) != uint64(len(part.DocIDs))*uint64(part.Dimension)*float32Bytes {
		return VectorIndexPart{}, invalidVectorPayload("vectors must hold dimension float32 components per document",
			map[string]any{"count": len(part.DocIDs), "bytes": len(part.Vectors)})
	}
	codes, err := codesOf(record["codes"], part.Dimension, len(part.DocIDs))
	if err != nil {
		return VectorIndexPart{}, err
	}
	part.Codes = codes
	return part, nil
}

func allGraphs(graphs []any) bool {
	for _, graph := range graphs {
		record, isMap := graph.(map[string]any)
		if _, hasNodes := record["nodes"].([]any); !isMap || !hasNodes {
			return false
		}
	}
	return true
}

func codesOf(raw any, dimension uint32, count int) (model.Optional[VectorIndexCodes], error) {
	if raw == nil {
		return model.Optional[VectorIndexCodes]{}, nil
	}
	record, isMap := raw.(map[string]any)
	if !isMap {
		return model.Optional[VectorIndexCodes]{}, invalidVectorPayload("codes must be a map or nil", nil)
	}
	bits, _ := record["bits"].(float64)
	if bits != 1 && bits != 2 && bits != 4 && bits != 8 {
		return model.Optional[VectorIndexCodes]{}, invalidVectorPayload("codes.bits must be 8, 4, 2, or 1",
			map[string]any{"bits": record["bits"]})
	}
	centroid, isList := record["centroid"].([]any)
	if !isList || len(centroid) != int(dimension) {
		return model.Optional[VectorIndexCodes]{}, invalidVectorPayload("codes.centroid must hold one number per dimension", nil)
	}
	codes := VectorIndexCodes{Bits: uint8(bits), Centroid: make([]float64, len(centroid))}
	for index, element := range centroid {
		number, isNumber := element.(float64)
		if !isNumber {
			return model.Optional[VectorIndexCodes]{}, invalidVectorPayload("codes.centroid must hold one number per dimension", nil)
		}
		codes.Centroid[index] = number
	}
	records, isBytes := record["records"].([]byte)
	if !isBytes {
		return model.Optional[VectorIndexCodes]{}, invalidVectorPayload("codes.records must be bytes", nil)
	}
	recordBytes := (uint64(dimension)*uint64(codes.Bits)+bitsPerByte-1)/bitsPerByte + osqRecordTrailerBytes
	if uint64(len(records)) != uint64(count)*recordBytes {
		return model.Optional[VectorIndexCodes]{}, invalidVectorPayload("codes.records must hold one record per vector",
			map[string]any{"count": count, "bytes": len(records)})
	}
	codes.Records = records
	return model.Some(codes), nil
}
