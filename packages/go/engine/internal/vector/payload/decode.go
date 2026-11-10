package payload

import (
	"math"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

const (
	vectorFileName = "vector file"
	graphName      = "vector graph"
	graphPartName  = "vector graph part"
)

func integerUpTo(value any, highest float64) (float64, bool) {
	number, isNumber := value.(float64)
	if !isNumber || number < 0 || number > highest || number != math.Trunc(number) {
		return 0, false
	}
	return number, true
}

func requireVersion(payload string, found any, expected int) error {
	if number, isNumber := found.(float64); isNumber && number == float64(expected) {
		return nil
	}
	described := "undefined"
	switch value := found.(type) {
	case float64:
		described = strconv.FormatFloat(value, 'f', -1, 64)
	case string:
		described = value
	}
	return narsilerr.New(narsilerr.CodeEnvelopeVersionMismatch,
		"This "+payload+" payload was written in layout "+described+", and this build reads layout "+
			strconv.Itoa(expected)+" alone", map[string]any{"version": found})
}

func unpack(data []byte) (any, error) {
	return codec.Unmarshal(data, codec.DecodeOptions{ErrorCode: narsilerr.CodePersistenceLoadFailed, ShareBinary: true})
}

func codesOf(raw any, dimension int, count int) (*Codes, error) {
	if raw == nil {
		return nil, nil
	}
	record, isMap := raw.(map[string]any)
	if !isMap {
		return nil, invalid("vector index", "codes must be a map or nil", nil)
	}
	bits, _ := record["bits"].(float64)
	if bits != 1 && bits != 2 && bits != 4 && bits != 8 {
		return nil, invalid("vector index", "codes.bits must be 8, 4, 2, or 1", map[string]any{"bits": record["bits"]})
	}
	list, isList := record["centroid"].([]any)
	if !isList || len(list) != dimension {
		return nil, invalid("vector index", "codes.centroid must hold one number per dimension", nil)
	}
	centroid := make([]float64, dimension)
	for index, element := range list {
		number, isNumber := element.(float64)
		if !isNumber {
			number = math.NaN()
		}
		centroid[index] = number
	}
	records, isBytes := record["records"].([]byte)
	if !isBytes {
		return nil, invalid("vector index", "codes.records must be bytes", nil)
	}
	if uint64(len(records)) != uint64(count)*uint64(RecordBytes(dimension, uint8(bits))) {
		return nil, invalid("vector index", "codes.records must hold one record per vector",
			map[string]any{"count": count, "bytes": len(records)})
	}
	return &Codes{Bits: uint8(bits), Centroid: centroid, Records: records}, nil
}

func stringsOf(raw any) ([]string, bool) {
	list, isList := raw.([]any)
	if !isList {
		return nil, false
	}
	texts := make([]string, len(list))
	for index, element := range list {
		text, isText := element.(string)
		if !isText {
			return nil, false
		}
		texts[index] = text
	}
	return texts, true
}

func optionalBytes(record map[string]any, key string, length int) ([]byte, error) {
	value, present := record[key]
	if !present {
		return nil, nil
	}
	data, isBytes := value.([]byte)
	if !isBytes || len(data) != length {
		return nil, invalid(vectorFileName, key+" must hold one value per vector", map[string]any{"key": key})
	}
	return data, nil
}

func DecodeVectorFile(raw any) (VectorFile, error) {
	record, isMap := raw.(map[string]any)
	if !isMap {
		return VectorFile{}, invalid(vectorFileName, "payload must be a map", nil)
	}
	if err := requireVersion(vectorFileName, record["v"], VectorFilePayloadVersion); err != nil {
		return VectorFile{}, err
	}
	file := VectorFile{}
	var valid bool
	if file.FieldName, valid = record["fieldName"].(string); !valid {
		return VectorFile{}, invalid(vectorFileName, "fieldName must be a string", nil)
	}
	dimension, valid := integerUpTo(record["dimension"], MaxDimension)
	if !valid || dimension == 0 {
		return VectorFile{}, invalid(vectorFileName, "dimension must be a positive uint16", nil)
	}
	file.Dimension = int(dimension)
	if file.DocIDs, valid = stringsOf(record["docIds"]); !valid {
		return VectorFile{}, invalid(vectorFileName, "docIds must be a list of strings", nil)
	}
	count := len(file.DocIDs)
	if count > VectorFileMaxVectors {
		return VectorFile{}, invalid(vectorFileName, "a file holds at most "+strconv.Itoa(VectorFileMaxVectors)+
			" vectors", map[string]any{"count": count})
	}
	if file.Vectors, valid = record["vectors"].([]byte); !valid {
		return VectorFile{}, invalid(vectorFileName, "vectors must be bytes", nil)
	}
	if uint64(len(file.Vectors)) != uint64(count)*uint64(file.Dimension)*float32Bytes {
		return VectorFile{}, invalid(vectorFileName, "vectors must hold dimension float32 components per document",
			map[string]any{"count": count, "bytes": len(file.Vectors)})
	}
	codes, err := codesOf(record["codes"], file.Dimension, count)
	if err != nil {
		return VectorFile{}, err
	}
	file.Codes = codes
	if file.Magnitudes, err = optionalBytes(record, "magnitudes", count*float64Bytes); err != nil {
		return VectorFile{}, err
	}
	if file.IDOrder, err = optionalBytes(record, "idOrder", count*uint32Bytes); err != nil {
		return VectorFile{}, err
	}
	_, file.HasHead = record["head"].([]byte)
	return file, nil
}

func isMetric(value any) (model.VectorMetric, bool) {
	text, isText := value.(string)
	switch model.VectorMetric(text) {
	case model.MetricCosine, model.MetricDotProduct, model.MetricEuclidean:
		return model.VectorMetric(text), isText
	}
	return "", false
}

func decodeNumberedGraph(raw any) (NumberedGraph, error) {
	record, isMap := raw.(map[string]any)
	if !isMap {
		return NumberedGraph{}, invalid(graphName, "each graph must be a map", nil)
	}
	graph := NumberedGraph{}
	if entry := record["entryPoint"]; entry != nil {
		number, valid := integerUpTo(entry, math.MaxUint32)
		if !valid {
			return NumberedGraph{}, invalid(graphName, "entryPoint must be a uint32 or nil", nil)
		}
		graph.EntryPoint = model.Some(uint32(number))
	}
	maxLayer, valid := integerUpTo(record["maxLayer"], math.MaxUint8)
	if !valid {
		return NumberedGraph{}, invalid(graphName, "maxLayer must be a uint8", nil)
	}
	graph.MaxLayer = uint8(maxLayer)
	m, valid := integerUpTo(record["m"], MaxM)
	if !valid || int(m) < MinM {
		return NumberedGraph{}, invalid(graphName, "m must be a whole number from "+strconv.Itoa(MinM)+" to "+
			strconv.Itoa(MaxM), nil)
	}
	graph.M = int(m)
	efConstruction, valid := integerUpTo(record["efConstruction"], math.MaxUint16)
	if !valid {
		return NumberedGraph{}, invalid(graphName, "efConstruction must be a uint16", nil)
	}
	graph.EfConstruction = int(efConstruction)
	if graph.Metric, valid = isMetric(record["metric"]); !valid {
		return NumberedGraph{}, invalid(graphName, "metric must name a supported metric",
			map[string]any{"metric": record["metric"]})
	}
	if graph.Levels, valid = record["levels"].([]byte); !valid {
		return NumberedGraph{}, invalid(graphName, "levels must be bytes", nil)
	}
	if graph.Neighbours, valid = record["neighbours"].([]byte); !valid {
		return NumberedGraph{}, invalid(graphName, "neighbours must be bytes", nil)
	}
	if mean := record["calibratedMeanLength"]; mean != nil {
		number, isNumber := mean.(float64)
		if !isNumber || math.IsNaN(number) || math.IsInf(number, 0) || number < 0 {
			return NumberedGraph{}, invalid(graphName, "calibratedMeanLength must be a finite float64 of at least 0", nil)
		}
		graph.CalibratedMeanLength = model.Some(number)
	}
	shuffled := record["shuffledBuildCount"]
	if shuffled == nil {
		graph.CalibratedMeanLength = model.Optional[float64]{}
		return graph, nil
	}
	count, valid := integerUpTo(shuffled, math.MaxUint32)
	if !valid {
		return NumberedGraph{}, invalid(graphName, "shuffledBuildCount must be a uint32", nil)
	}
	graph.ShuffledBuildCount = model.Some(uint32(count))
	return graph, nil
}

func decodeGraphs(raw any, name string, version int) (GraphPart, error) {
	record, isMap := raw.(map[string]any)
	if !isMap {
		return GraphPart{}, invalid(name, "payload must be a map", nil)
	}
	if err := requireVersion(name, record["v"], version); err != nil {
		return GraphPart{}, err
	}
	fieldName, valid := record["fieldName"].(string)
	if !valid {
		return GraphPart{}, invalid(name, "fieldName must be a string", nil)
	}
	list, isList := record["graphs"].([]any)
	if !isList {
		return GraphPart{}, invalid(name, "graphs must be a list", nil)
	}
	part := GraphPart{FieldName: fieldName, Graphs: make([]NumberedGraph, 0, len(list))}
	for _, element := range list {
		graph, err := decodeNumberedGraph(element)
		if err != nil {
			return GraphPart{}, err
		}
		part.Graphs = append(part.Graphs, graph)
	}
	return part, nil
}

func DecodeGraphPart(raw any) (GraphPart, error) {
	return decodeGraphs(raw, graphPartName, VectorGraphPartPayloadVersion)
}

func DecodeEarlierGraph(raw any) (GraphPart, error) {
	return decodeGraphs(raw, graphName, VectorGraphPayloadVersion)
}

func OpenVectorFile(data []byte, what string) (VectorFile, envelope.Header, error) {
	opened, err := envelope.OpenChecksummed(data, envelope.Kind{FormatVersion: VectorFileEnvelopeVersion, What: what})
	if err != nil {
		return VectorFile{}, envelope.Header{}, err
	}
	raw, err := unpack(opened.Payload)
	if err != nil {
		return VectorFile{}, envelope.Header{}, err
	}
	file, err := DecodeVectorFile(raw)
	return file, opened.Header, err
}

func OpenGraphPart(data []byte, what string) (GraphPart, envelope.Header, error) {
	opened, err := envelope.OpenChecksummed(data,
		envelope.Kind{FormatVersion: GraphPartEnvelopeVersion, What: what, AllowsGzip: true})
	if err != nil {
		return GraphPart{}, envelope.Header{}, err
	}
	raw, err := unpack(opened.Payload)
	if err != nil {
		return GraphPart{}, envelope.Header{}, err
	}
	part, err := DecodeGraphPart(raw)
	return part, opened.Header, err
}
