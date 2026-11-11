package payload

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
)

type Written struct {
	Bytes        []byte
	HasHead      bool
	HeadOffset   int64
	HeadLength   int64
	HeadChecksum uint32
}

func appendCodes(destination []byte, codes *Codes) []byte {
	if codes == nil {
		return codec.AppendNil(destination)
	}
	destination = codec.AppendMapHeader(destination, 3)
	destination = codec.AppendNumber(codec.AppendString(destination, "bits"), float64(codes.Bits), false)
	destination = codec.AppendArrayHeader(codec.AppendString(destination, "centroid"), len(codes.Centroid))
	for _, component := range codes.Centroid {
		destination = codec.AppendNumber(destination, component, false)
	}
	return codec.AppendBinary(codec.AppendString(destination, "records"), codes.Records)
}

func appendFileOpening(destination []byte, file VectorFile, entries int) []byte {
	destination = codec.AppendMapHeader(destination, entries)
	destination = codec.AppendNumber(codec.AppendString(destination, "v"), VectorFilePayloadVersion, false)
	destination = codec.AppendString(codec.AppendString(destination, "fieldName"), file.FieldName)
	return codec.AppendNumber(codec.AppendString(destination, "dimension"), float64(file.Dimension), false)
}

func appendDocIDs(destination []byte, docIDs []string) []byte {
	destination = codec.AppendArrayHeader(destination, len(docIDs))
	for _, docID := range docIDs {
		destination = codec.AppendString(destination, docID)
	}
	return destination
}

func vectorFileBytes(file VectorFile) int {
	total := len(file.Vectors) + len(file.FieldName) + 128 + len(file.DocIDs)*5
	for _, docID := range file.DocIDs {
		total += len(docID)
	}
	if file.Codes != nil {
		total += len(file.Codes.Records) + len(file.Codes.Centroid)*9
	}
	return total
}

func EncodeVectorFile(file VectorFile) []byte {
	payload := make([]byte, 0, vectorFileBytes(file))
	payload = appendFileOpening(payload, file, 6)
	payload = appendDocIDs(codec.AppendString(payload, "docIds"), file.DocIDs)
	payload = appendCodes(codec.AppendString(payload, "codes"), file.Codes)
	return codec.AppendBinary(codec.AppendString(payload, "vectors"), file.Vectors)
}

func appendGraphHeader(destination []byte, graph NumberedGraph, extra int) []byte {
	entries := 5 + extra
	if graph.ShuffledBuildCount.IsSet() {
		entries++
	}
	if graph.CalibratedMeanLength.IsSet() {
		entries++
	}
	destination = codec.AppendMapHeader(destination, entries)
	destination = codec.AppendString(destination, "entryPoint")
	if entry, set := graph.EntryPoint.Get(); set {
		destination = codec.AppendNumber(destination, float64(entry), false)
	} else {
		destination = codec.AppendNil(destination)
	}
	destination = codec.AppendNumber(codec.AppendString(destination, "maxLayer"), float64(graph.MaxLayer), false)
	destination = codec.AppendNumber(codec.AppendString(destination, "m"), float64(graph.M), false)
	destination = codec.AppendNumber(codec.AppendString(destination, "efConstruction"), float64(graph.EfConstruction), false)
	return codec.AppendString(codec.AppendString(destination, "metric"), string(graph.Metric))
}

func appendBuildHistory(destination []byte, graph NumberedGraph) []byte {
	if count, set := graph.ShuffledBuildCount.Get(); set {
		destination = codec.AppendNumber(codec.AppendString(destination, "shuffledBuildCount"), float64(count), false)
	}
	if mean, set := graph.CalibratedMeanLength.Get(); set {
		destination = codec.AppendNumber(codec.AppendString(destination, "calibratedMeanLength"), mean, false)
	}
	return destination
}

func appendGraphPartOpening(destination []byte, part GraphPart, entries int) []byte {
	destination = codec.AppendMapHeader(destination, entries)
	destination = codec.AppendNumber(codec.AppendString(destination, "v"), VectorGraphPartPayloadVersion, false)
	destination = codec.AppendString(codec.AppendString(destination, "fieldName"), part.FieldName)
	return codec.AppendArrayHeader(codec.AppendString(destination, "graphs"), len(part.Graphs))
}

func graphPartBytes(part GraphPart) int {
	total := len(part.FieldName) + 64
	for _, graph := range part.Graphs {
		total += len(graph.Levels) + len(graph.Neighbours) + 160
	}
	return total
}

func EncodeGraphPart(part GraphPart) []byte {
	payload := appendGraphPartOpening(make([]byte, 0, graphPartBytes(part)), part, 3)
	for _, graph := range part.Graphs {
		payload = appendGraphHeader(payload, graph, 2)
		payload = codec.AppendBinary(codec.AppendString(payload, "levels"), graph.Levels)
		payload = codec.AppendBinary(codec.AppendString(payload, "neighbours"), graph.Neighbours)
		payload = appendBuildHistory(payload, graph)
	}
	return payload
}

func pack(payload []byte, what string, gzip bool, formatVersion uint8) ([]byte, error) {
	return envelope.Pack(payload, envelope.PackOptions{FormatVersion: formatVersion, What: what, Gzip: gzip, Checksum: true})
}

func PackVectorFile(file VectorFile, magnitudes []float64, disk bool, what string) (Written, error) {
	if !disk && magnitudes == nil {
		packed, err := pack(EncodeVectorFile(file), what, false, VectorFileEnvelopeVersion)
		return Written{Bytes: packed}, err
	}
	paged, err := encodeDiskVectorFile(file, magnitudes)
	if err != nil {
		return Written{}, err
	}
	packed, err := pack(paged.Bytes, what, false, VectorFileEnvelopeVersion)
	paged.Bytes = packed
	return paged, err
}

func PackGraphPart(part GraphPart, disk bool, gzip bool, what string) (Written, error) {
	if !disk {
		packed, err := pack(EncodeGraphPart(part), what, gzip, GraphPartEnvelopeVersion)
		return Written{Bytes: packed}, err
	}
	paged, err := encodeDiskGraphPart(part)
	if err != nil {
		return Written{}, err
	}
	packed, err := pack(paged.Bytes, what, false, GraphPartEnvelopeVersion)
	paged.Bytes = packed
	return paged, err
}
