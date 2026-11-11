package payload

import (
	"encoding/binary"
	"math"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/form"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

const (
	StorageMemory = "memory"
	StorageDisk   = "disk"
)

var diskVectorFileKeys = []string{"magnitudes", "idOffsets", "idOrder", "head"}

func formFailed(message string) error {
	return narsilerr.New(narsilerr.CodePersistenceLoadFailed, message, nil)
}

func requireDiskKeys(record map[string]any, keys []string, storage string, what string) error {
	if storage != StorageDisk {
		return nil
	}
	for _, key := range keys {
		if _, held := record[key]; !held {
			return formFailed("The " + what + " belongs to a disk field and holds no " + key)
		}
	}
	return nil
}

func openedRecord(data []byte, kind envelope.Kind) (envelope.Header, map[string]any, any, error) {
	opened, err := envelope.OpenChecksummed(data, kind)
	if err != nil {
		return envelope.Header{}, nil, nil, err
	}
	raw, err := unpack(opened.Payload)
	if err != nil {
		return envelope.Header{}, nil, nil, err
	}
	record, _ := raw.(map[string]any)
	return opened.Header, record, raw, nil
}

func recordsValue(codes *Codes, dimension int, count int) []any {
	codeBytes := RecordBytes(dimension, codes.Bits) - recordTrailerBytes
	stride := codeBytes + recordTrailerBytes
	records := make([]any, 0, count)
	for at := range count {
		record := codes.Records[at*stride : (at+1)*stride]
		tail := record[codeBytes:]
		float := func(offset int) float64 {
			return float64(math.Float32frombits(binary.LittleEndian.Uint32(tail[offset:])))
		}
		records = append(records, map[string]any{
			"code":       form.Values(record[:codeBytes], form.WidthUint8),
			"lower":      float(0),
			"upper":      float(4),
			"correction": float(8),
			"sum":        float64(binary.LittleEndian.Uint32(tail[12:])),
		})
	}
	return records
}

func vectorsValue(file VectorFile) []any {
	vectors := make([]any, 0, file.Count())
	for at := range file.Count() {
		values := make([]float32, file.Dimension)
		file.Vector(at, values)
		vectors = append(vectors, values)
	}
	return vectors
}

func VectorFileFormOf(data []byte, storage string, what string) (map[string]any, error) {
	header, record, raw, err := openedRecord(data, envelope.Kind{FormatVersion: VectorFileEnvelopeVersion, What: what})
	if err != nil {
		return nil, err
	}
	file, err := DecodeVectorFile(raw)
	if err != nil {
		return nil, err
	}
	if err := requireDiskKeys(record, diskVectorFileKeys, storage, what); err != nil {
		return nil, err
	}
	payload := map[string]any{
		"v": float64(VectorFilePayloadVersion), "fieldName": file.FieldName, "dimension": float64(file.Dimension),
		"docIds": form.StringValues(file.DocIDs), "codes": nil, "vectors": vectorsValue(file),
	}
	if file.Codes != nil {
		payload["codes"] = map[string]any{
			"bits": float64(file.Codes.Bits), "centroid": file.Codes.Centroid,
			"records": recordsValue(file.Codes, file.Dimension, file.Count()),
		}
	}
	if file.Magnitudes != nil {
		payload["magnitudes"] = form.Values(file.Magnitudes, form.WidthFloat64)
	}
	if file.IDOrder != nil {
		payload["idOrder"] = form.Values(file.IDOrder, form.WidthUint32)
	}
	return map[string]any{"header": form.HeaderOf(header).Value(), "storage": storage, "payload": payload}, nil
}

func neighboursValue(graph NumberedGraph) ([]any, error) {
	values := len(graph.Neighbours) / uint32Bytes
	if len(graph.Neighbours)%uint32Bytes != 0 {
		return nil, endsInsideAList()
	}
	nodes := []any{}
	cursor := 0
	for _, level := range graph.Levels {
		if level == 0 {
			continue
		}
		layers := make([]any, 0, level)
		for range int(level) {
			if cursor >= values {
				return nil, endsInsideAList()
			}
			count := int(NeighbourValue(graph.Neighbours, cursor))
			if count > values-cursor-1 {
				return nil, endsInsideAList()
			}
			start := (cursor + 1) * uint32Bytes
			layers = append(layers, form.Values(graph.Neighbours[start:start+count*uint32Bytes], form.WidthUint32))
			cursor += count + 1
		}
		nodes = append(nodes, layers)
	}
	if cursor != values {
		return nil, formFailed("The vector graph part holds values after the last node's lists")
	}
	return nodes, nil
}

func graphValue(graph NumberedGraph) (map[string]any, error) {
	neighbours, err := neighboursValue(graph)
	if err != nil {
		return nil, err
	}
	value := map[string]any{
		"entryPoint": nil, "maxLayer": float64(graph.MaxLayer), "m": float64(graph.M),
		"efConstruction": float64(graph.EfConstruction), "metric": string(graph.Metric),
		"levels": form.Values(graph.Levels, form.WidthUint8), "neighbours": neighbours,
	}
	if entry, set := graph.EntryPoint.Get(); set {
		value["entryPoint"] = float64(entry)
	}
	if count, set := graph.ShuffledBuildCount.Get(); set {
		value["shuffledBuildCount"] = float64(count)
	}
	if mean, set := graph.CalibratedMeanLength.Get(); set {
		value["calibratedMeanLength"] = mean
	}
	return value, nil
}

func GraphPartFormOf(data []byte, storage string, what string) (map[string]any, error) {
	header, record, raw, err := openedRecord(data,
		envelope.Kind{FormatVersion: GraphPartEnvelopeVersion, What: what, AllowsGzip: true})
	if err != nil {
		return nil, err
	}
	part, err := DecodeGraphPart(raw)
	if err != nil {
		return nil, err
	}
	if err := requireDiskKeys(record, []string{"head"}, storage, what); err != nil {
		return nil, err
	}
	graphs := make([]any, 0, len(part.Graphs))
	for _, graph := range part.Graphs {
		value, err := graphValue(graph)
		if err != nil {
			return nil, err
		}
		graphs = append(graphs, value)
	}
	payload := map[string]any{"v": float64(VectorGraphPartPayloadVersion), "fieldName": part.FieldName, "graphs": graphs}
	return map[string]any{"header": form.HeaderOf(header).Value(), "storage": storage, "payload": payload}, nil
}
