package payload

import (
	"encoding/binary"
	"math"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type Codes struct {
	Bits     uint8
	Centroid []float64
	Records  []byte
}

type VectorFile struct {
	FieldName  string
	Dimension  int
	DocIDs     []string
	Codes      *Codes
	Magnitudes []byte
	IDOrder    []byte
	HasHead    bool
	Vectors    []byte
}

type NumberedGraph struct {
	EntryPoint           model.Optional[uint32]
	MaxLayer             uint8
	M                    int
	EfConstruction       int
	Metric               model.VectorMetric
	Levels               []byte
	Neighbours           []byte
	ShuffledBuildCount   model.Optional[uint32]
	CalibratedMeanLength model.Optional[float64]
}

type GraphPart struct {
	FieldName string
	Graphs    []NumberedGraph
}

type NumberedGraphParts struct {
	PartSize int
	Parts    []NumberedGraph
}

type GraphParts struct {
	FieldName string
	Graphs    []NumberedGraphParts
}

func RecordBytes(dimension int, bits uint8) int {
	return (dimension*int(bits)+bitsPerByte-1)/bitsPerByte + recordTrailerBytes
}

func (file *VectorFile) Count() int {
	return len(file.DocIDs)
}

func (file *VectorFile) Vector(position int, target []float32) bool {
	stride := file.Dimension * float32Bytes
	start := position * stride
	if position < 0 || len(target) < file.Dimension || start+stride > len(file.Vectors) {
		return false
	}
	for component := range file.Dimension {
		bits := binary.LittleEndian.Uint32(file.Vectors[start+component*float32Bytes:])
		target[component] = math.Float32frombits(bits)
	}
	return true
}

func (file *VectorFile) Record(position int) []byte {
	if file.Codes == nil {
		return nil
	}
	stride := RecordBytes(file.Dimension, file.Codes.Bits)
	start := position * stride
	if position < 0 || start+stride > len(file.Codes.Records) {
		return nil
	}
	return file.Codes.Records[start : start+stride]
}

func (file *VectorFile) Magnitude(position int) (float64, bool) {
	start := position * float64Bytes
	if position < 0 || start+float64Bytes > len(file.Magnitudes) {
		return 0, false
	}
	return math.Float64frombits(binary.LittleEndian.Uint64(file.Magnitudes[start:])), true
}

func (graph NumberedGraph) TopLayerAt(at int) int {
	if at < 0 || at >= len(graph.Levels) {
		return -1
	}
	return int(graph.Levels[at]) - 1
}

func (parts NumberedGraphParts) TopLayer(number int) int {
	if number < 0 || parts.PartSize <= 0 {
		return -1
	}
	index := number / parts.PartSize
	if index >= len(parts.Parts) {
		return -1
	}
	return parts.Parts[index].TopLayerAt(number % parts.PartSize)
}

func invalid(payload string, message string, details map[string]any) error {
	return narsilerr.New(narsilerr.CodePersistenceLoadFailed, "Invalid "+payload+" payload: "+message, details)
}
