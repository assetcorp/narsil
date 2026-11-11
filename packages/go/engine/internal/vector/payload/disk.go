package payload

import (
	"encoding/binary"
	"math"
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type section struct {
	name      string
	offset    int
	length    int
	pageBytes int
	checksums []byte
}

func pageChecksums(data []byte, pageBytes int) []byte {
	pages := (len(data) + pageBytes - 1) / pageBytes
	checksums := make([]byte, 0, pages*pageChecksumBytes)
	for page := range pages {
		from := page * pageBytes
		checksums = binary.LittleEndian.AppendUint32(checksums, codec.CRC32(data[from:min(from+pageBytes, len(data))]))
	}
	return checksums
}

func sectionOf(name string, offset int, data []byte, pageBytes int) section {
	return section{name: name, offset: offset, length: len(data), pageBytes: pageBytes, checksums: pageChecksums(data, pageBytes)}
}

func (s section) value() codec.OrderedMap {
	return codec.OrderedMap{
		{Key: "name", Value: s.name},
		{Key: "offset", Value: float64(s.offset)},
		{Key: "length", Value: float64(s.length)},
		{Key: "pageBytes", Value: float64(s.pageBytes)},
		{Key: "checksums", Value: s.checksums},
	}
}

func sectionsValue(sections []section) []any {
	values := make([]any, len(sections))
	for index, entry := range sections {
		values[index] = entry.value()
	}
	return values
}

func appendBytesEntry(destination []byte, key string, data []byte) ([]byte, int) {
	destination = codec.AppendBinaryHeader(codec.AppendString(destination, key), len(data))
	at := len(destination)
	return append(destination, data...), at
}

func uint32Values(values []uint32) []byte {
	data := make([]byte, 0, len(values)*uint32Bytes)
	for _, value := range values {
		data = binary.LittleEndian.AppendUint32(data, value)
	}
	return data
}

func encodedIDList(docIDs []string) ([]byte, []uint32) {
	list := codec.AppendArrayHeader(nil, len(docIDs))
	offsets := make([]uint32, len(docIDs)+1)
	for index, docID := range docIDs {
		offsets[index] = uint32(len(list))
		list = codec.AppendString(list, docID)
	}
	offsets[len(docIDs)] = uint32(len(list))
	return list, offsets
}

func positionsInIDOrder(docIDs []string) []uint32 {
	positions := make([]uint32, len(docIDs))
	for index := range positions {
		positions[index] = uint32(index)
	}
	slices.SortStableFunc(positions, func(left, right uint32) int {
		return text.CompareCodePoints(docIDs[left], docIDs[right])
	})
	return positions
}

func magnitudeBytes(magnitudes []float64, count int) []byte {
	data := make([]byte, 0, count*float64Bytes)
	for index := range count {
		value := 0.0
		if index < len(magnitudes) {
			value = magnitudes[index]
		}
		data = binary.LittleEndian.AppendUint64(data, math.Float64bits(value))
	}
	return data
}

func saveFailed(message string) error {
	return narsilerr.New(narsilerr.CodePersistenceSaveFailed, message, nil)
}

func encodeDiskVectorFile(file VectorFile, magnitudes []float64) (Written, error) {
	payload := appendFileOpening(make([]byte, 0, vectorFileBytes(file)*2), file, 10)
	list, offsets := encodedIDList(file.DocIDs)
	payload = codec.AppendString(payload, "docIds")
	sections := []section{sectionOf("docIds", len(payload), list, SegmentPageBytes)}
	payload = append(payload, list...)
	payload = codec.AppendString(payload, "codes")
	if file.Codes == nil {
		payload = codec.AppendNil(payload)
	} else {
		payload = codec.AppendMapHeader(payload, 3)
		payload = codec.AppendNumber(codec.AppendString(payload, "bits"), float64(file.Codes.Bits), false)
		payload = codec.AppendArrayHeader(codec.AppendString(payload, "centroid"), len(file.Codes.Centroid))
		for _, component := range file.Codes.Centroid {
			payload = codec.AppendNumber(payload, component, false)
		}
		var at int
		payload, at = appendBytesEntry(payload, "records", file.Codes.Records)
		sections = append(sections, sectionOf("records", at, file.Codes.Records, RecordPageBytes))
	}
	for _, entry := range []struct {
		name string
		data []byte
	}{
		{"magnitudes", magnitudeBytes(magnitudes, file.Count())},
		{"idOffsets", uint32Values(offsets)},
		{"idOrder", uint32Values(positionsInIDOrder(file.DocIDs))},
	} {
		var at int
		payload, at = appendBytesEntry(payload, entry.name, entry.data)
		sections = append(sections, sectionOf(entry.name, at, entry.data, SegmentPageBytes))
	}
	beforeHead := len(codec.AppendString(payload, "head"))
	vectorsKeyAndHeader := len(codec.AppendBinaryHeader(codec.AppendString(nil, "vectors"), len(file.Vectors)))
	vectors := sectionOf("vectors", 0, file.Vectors, SegmentPageBytes)
	var head []byte
	headLength := 0
	for range stableHeadAttempts {
		headBinaryHeader := len(codec.AppendBinaryHeader(nil, headLength))
		vectors.offset = beforeHead + headBinaryHeader + headLength + vectorsKeyAndHeader
		encoded, err := codec.Marshal(codec.OrderedMap{{Key: "sections", Value: sectionsValue(append(slices.Clone(sections), vectors))}},
			codec.EncodeOptions{ErrorCode: narsilerr.CodePersistenceSaveFailed})
		if err != nil {
			return Written{}, err
		}
		head = encoded
		if len(head) == headLength {
			break
		}
		headLength = len(head)
	}
	payload, headOffset := appendBytesEntry(payload, "head", head)
	payload = codec.AppendBinary(codec.AppendString(payload, "vectors"), file.Vectors)
	return Written{Bytes: payload, HasHead: true, HeadOffset: int64(headOffset), HeadLength: int64(len(head)),
		HeadChecksum: codec.CRC32(head)}, nil
}

func nodeOffsetsOf(graph NumberedGraph) ([]byte, error) {
	offsets := make([]uint32, len(graph.Levels)+1)
	values := len(graph.Neighbours) / uint32Bytes
	cursor := 0
	for at, level := range graph.Levels {
		offsets[at] = uint32(cursor * uint32Bytes)
		for range int(level) {
			if cursor >= values {
				return nil, saveFailed("a graph part ends its neighbours inside a list")
			}
			cursor += int(NeighbourValue(graph.Neighbours, cursor)) + 1
		}
	}
	if cursor > values {
		return nil, saveFailed("a graph part ends its neighbours inside a list")
	}
	offsets[len(graph.Levels)] = uint32(cursor * uint32Bytes)
	return uint32Values(offsets), nil
}

func graphHeaderValue(graph NumberedGraph) codec.OrderedMap {
	var entry any
	if number, set := graph.EntryPoint.Get(); set {
		entry = float64(number)
	}
	header := codec.OrderedMap{
		{Key: "entryPoint", Value: entry},
		{Key: "maxLayer", Value: float64(graph.MaxLayer)},
		{Key: "m", Value: float64(graph.M)},
		{Key: "efConstruction", Value: float64(graph.EfConstruction)},
		{Key: "metric", Value: string(graph.Metric)},
	}
	if count, set := graph.ShuffledBuildCount.Get(); set {
		header = append(header, codec.MapEntry{Key: "shuffledBuildCount", Value: float64(count)})
	}
	if mean, set := graph.CalibratedMeanLength.Get(); set {
		header = append(header, codec.MapEntry{Key: "calibratedMeanLength", Value: mean})
	}
	return header
}

func encodeDiskGraphPart(part GraphPart) (Written, error) {
	payload := appendGraphPartOpening(make([]byte, 0, graphPartBytes(part)), part, 4)
	layouts := make([]any, 0, len(part.Graphs))
	for _, graph := range part.Graphs {
		payload = appendGraphHeader(payload, graph, 2)
		payload = appendBuildHistory(payload, graph)
		var levelsAt, neighboursAt int
		payload, levelsAt = appendBytesEntry(payload, "levels", graph.Levels)
		payload, neighboursAt = appendBytesEntry(payload, "neighbours", graph.Neighbours)
		nodeOffsets, err := nodeOffsetsOf(graph)
		if err != nil {
			return Written{}, err
		}
		layout := graphHeaderValue(graph)
		layout = append(layout,
			codec.MapEntry{Key: "levels", Value: sectionOf("levels", levelsAt, graph.Levels, SegmentPageBytes).value()},
			codec.MapEntry{Key: "nodeOffsets", Value: nodeOffsets},
			codec.MapEntry{Key: "neighbours", Value: sectionOf("neighbours", neighboursAt, graph.Neighbours, RecordPageBytes).value()})
		layouts = append(layouts, layout)
	}
	head, err := codec.Marshal(codec.OrderedMap{{Key: "graphs", Value: layouts}},
		codec.EncodeOptions{ErrorCode: narsilerr.CodePersistenceSaveFailed})
	if err != nil {
		return Written{}, err
	}
	payload, headOffset := appendBytesEntry(payload, "head", head)
	return Written{Bytes: payload, HasHead: true, HeadOffset: int64(headOffset), HeadLength: int64(len(head)),
		HeadChecksum: codec.CRC32(head)}, nil
}
