package payload

import (
	"encoding/binary"
	"math"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/form"
)

func storageFrom(root *form.Fields) string {
	storage := root.String("storage")
	if storage != StorageMemory && storage != StorageDisk {
		root.Fail("storage", "is neither \"memory\" nor \"disk\"")
	}
	return storage
}

func checkpointHeader(root *form.Fields) form.HeaderForm {
	header := form.HeaderFrom(root.Object("header"))
	if header.Gzip || !header.Checksum {
		root.Fail("header", "must be uncompressed and carry a checksum, as every checkpoint file does")
	}
	return header
}

func recordsFrom(codes *form.Fields, dimension int, bits int) []byte {
	list := codes.List("records")
	codeBytes := (dimension*bits + bitsPerByte - 1) / bitsPerByte
	records := make([]byte, 0, len(list)*(codeBytes+recordTrailerBytes))
	for at := range list {
		entry := codes.Element(list, "records", at)
		code := entry.NumberBytes("code", form.WidthUint8)
		if len(code) != codeBytes {
			entry.Fail("records["+strconv.Itoa(at)+"].code", "holds the wrong number of bytes")
			return nil
		}
		records = append(records, code...)
		for _, key := range []string{"lower", "upper", "correction"} {
			records = binary.LittleEndian.AppendUint32(records, math.Float32bits(float32(entry.Number(key))))
		}
		records = binary.LittleEndian.AppendUint32(records, uint32(entry.Uint("sum", math.MaxUint32)))
	}
	return records
}

func vectorFileRaw(payload *form.Fields) map[string]any {
	dimension := int(payload.Uint("dimension", MaxDimension))
	vectors := []any{}
	for at, element := range payload.List("vectors") {
		components, isList := element.([]any)
		if !isList {
			payload.Fail("vectors["+strconv.Itoa(at)+"]", "is not a list of numbers")
			return nil
		}
		vectors = append(vectors, components...)
	}
	raw := map[string]any{
		"v": payload.Value("v"), "fieldName": payload.Value("fieldName"), "dimension": payload.Value("dimension"),
		"docIds": payload.Value("docIds"), "codes": nil,
		"vectors": payload.NumberBytesAt(vectors, "vectors", form.WidthFloat32),
	}
	if payload.HasValue("codes") {
		codes := payload.Object("codes")
		bits := int(codes.Uint("bits", math.MaxUint8))
		raw["codes"] = map[string]any{"bits": codes.Value("bits"), "centroid": codes.Value("centroid"),
			"records": recordsFrom(codes, dimension, bits)}
	}
	return raw
}

func PackVectorFileForm(value map[string]any, what string) (Written, error) {
	root := form.NewFields(value, "", form.CodeJSONForm, "vector file JSON form")
	header := checkpointHeader(root)
	storage := storageFrom(root)
	payload := root.Object("payload")
	raw := vectorFileRaw(payload)
	var magnitudes []float64
	if payload.Has("magnitudes") {
		magnitudes = form.Values(payload.NumberBytes("magnitudes", form.WidthFloat64), form.WidthFloat64)
	}
	if err := root.Err(); err != nil {
		return Written{}, err
	}
	file, err := DecodeVectorFile(raw)
	if err != nil {
		return Written{}, err
	}
	written, err := PackVectorFile(file, magnitudes, storage == StorageDisk, what)
	if err != nil || header.FormatVersion == VectorFileEnvelopeVersion {
		return written, err
	}
	return repacked(written, header, what)
}

func repacked(written Written, header form.HeaderForm, what string) (Written, error) {
	opened, err := envelope.OpenUpTo(written.Bytes, math.MaxUint8, what)
	if err != nil {
		return Written{}, err
	}
	written.Bytes, err = envelope.Pack(opened.Payload, header.PackOptions(what))
	return written, err
}

func neighbourBytes(graph *form.Fields, levels []byte) []byte {
	nodes := graph.List("neighbours")
	data := []byte{}
	node := 0
	for _, level := range levels {
		if level == 0 {
			continue
		}
		path := "neighbours[" + strconv.Itoa(node) + "]"
		if node >= len(nodes) {
			graph.Fail(path, "is missing for a node that levels list")
			return nil
		}
		layers, isList := nodes[node].([]any)
		if !isList || len(layers) != int(level) {
			graph.Fail(path, "does not hold one list per layer of the node")
			return nil
		}
		for layer, list := range layers {
			ids := graph.NumberBytesAt(list, path+"["+strconv.Itoa(layer)+"]", form.WidthUint32)
			data = binary.LittleEndian.AppendUint32(data, uint32(len(ids)/uint32Bytes))
			data = append(data, ids...)
		}
		node++
	}
	if node != len(nodes) {
		graph.Fail("neighbours", "holds more nodes than levels give")
	}
	return data
}

func graphRaw(payload *form.Fields, list []any, at int) map[string]any {
	graph := payload.Element(list, "graphs", at)
	raw := map[string]any{}
	for _, key := range graph.Keys() {
		if key != "levels" && key != "neighbours" {
			raw[key] = graph.Value(key)
		}
	}
	levels := graph.NumberBytes("levels", form.WidthUint8)
	raw["levels"] = levels
	raw["neighbours"] = neighbourBytes(graph, levels)
	return raw
}

func PackGraphPartForm(value map[string]any, what string) (Written, error) {
	root := form.NewFields(value, "", form.CodeJSONForm, "vector graph part JSON form")
	storage := storageFrom(root)
	header := form.HeaderFrom(root.Object("header"))
	if storage == StorageDisk {
		header = checkpointHeader(root)
	}
	payload := root.Object("payload")
	raw := map[string]any{}
	for _, key := range payload.Keys() {
		raw[key] = payload.Value(key)
	}
	list := payload.List("graphs")
	graphs := make([]any, 0, len(list))
	for at := range list {
		graphs = append(graphs, graphRaw(payload, list, at))
	}
	raw["graphs"] = graphs
	if err := root.Err(); err != nil {
		return Written{}, err
	}
	part, err := DecodeGraphPart(raw)
	if err != nil {
		return Written{}, err
	}
	if storage == StorageDisk {
		written, err := PackGraphPart(part, true, false, what)
		if err != nil || header.FormatVersion == GraphPartEnvelopeVersion {
			return written, err
		}
		return repacked(written, header, what)
	}
	packed, err := envelope.Pack(EncodeGraphPart(part), header.PackOptions(what))
	return Written{Bytes: packed}, err
}
