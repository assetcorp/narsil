package persist

import (
	"context"
	"encoding/binary"
	"math"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/paged"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/checkpoint"
	"github.com/assetcorp/narsil/packages/go/engine/internal/vector/payload"
)

type coldGraphLayout struct {
	m           int
	levels      []byte
	entryPoint  int
	maxLayer    int
	nodeOffsets []uint32
	neighbours  paged.Section
}

func onlySection(raw any, payloadLength int64, key string, allowed []int64) (paged.Section, error) {
	sections, err := paged.DecodeSectionsAllowing([]any{raw}, payloadLength, `head of "`+key+`"`, allowed)
	if err != nil {
		return paged.Section{}, err
	}
	return sections[0], nil
}

func nodeOffsetsOf(raw any, levels paged.Section, neighbours paged.Section, key string) ([]uint32, error) {
	encoded, isBinary := raw.([]byte)
	if !isBinary || len(encoded)%uint32Bytes != 0 {
		return nil, coldLoadFailed(`The head of "`+key+`" holds no node offsets`, key)
	}
	count := int64(len(encoded) / uint32Bytes)
	if count != levels.Length+1 {
		return nil, coldLoadFailed(`The head of "`+key+`" holds the wrong number of offsets`, key)
	}
	offsets := make([]uint32, count)
	for at := range count {
		offsets[at] = binary.LittleEndian.Uint32(encoded[at*uint32Bytes:])
		if at > 0 && offsets[at] < offsets[at-1] {
			return nil, coldLoadFailed(`The head of "`+key+`" holds descending node offsets`, key)
		}
	}
	if int64(offsets[count-1]) > neighbours.Length {
		return nil, coldLoadFailed(`The node offsets of "`+key+`" end outside its neighbour lists`, key)
	}
	return offsets, nil
}

func layerOf(value float64) int {
	if math.IsNaN(value) || value < 0 {
		return -1
	}
	return int(math.Min(math.Floor(value), math.MaxInt32))
}

func graphNumberOf(value any) int {
	number, isNumber := value.(float64)
	if !isNumber || number != math.Trunc(number) || number < 0 || number > math.MaxInt32 {
		return -1
	}
	return int(number)
}

func wholeNumber(value any) (float64, bool) {
	number, isNumber := value.(float64)
	return number, isNumber && number == math.Trunc(number)
}

func requireColdGraphPart(ctx context.Context, store checkpoint.Store, ref manifest.FileRef) (coldGraphLayout,
	bool, error) {
	source, err := openColdSource(ctx, store, ref)
	if err != nil {
		return coldGraphLayout{}, false, err
	}
	defer source.close()
	layout, cold, err := readColdGraphLayout(source, ref)
	if err != nil || !cold {
		return layout, cold, err
	}
	if err := paged.CheckSectionPages(ctx, source.reader, layout.neighbours, ref.Key); err != nil {
		return coldGraphLayout{}, false, err
	}
	return layout, true, nil
}

func readColdGraphLayout(source coldSource, ref manifest.FileRef) (coldGraphLayout, bool, error) {
	head, cold, err := coldHead(source, ref)
	if err != nil || !cold {
		return coldGraphLayout{}, false, err
	}
	graphs, isList := head["graphs"].([]any)
	if !isList || len(graphs) != coldGraphLayoutsPerPartRef {
		return coldGraphLayout{}, false, nil
	}
	layout, isMap := graphs[0].(map[string]any)
	if !isMap {
		return coldGraphLayout{}, false, coldLoadFailed(`The head of "`+ref.Key+`" holds a graph that is not a map`,
			ref.Key)
	}
	payloadLength := source.size - envelope.HeaderBytes
	levels, err := onlySection(layout["levels"], payloadLength, ref.Key, levelPageSizes)
	if err != nil {
		return coldGraphLayout{}, false, err
	}
	neighbours, err := onlySection(layout["neighbours"], payloadLength, ref.Key, neighbourPageSizes)
	if err != nil {
		return coldGraphLayout{}, false, err
	}
	nodeOffsets, err := nodeOffsetsOf(layout["nodeOffsets"], levels, neighbours, ref.Key)
	if err != nil {
		return coldGraphLayout{}, false, err
	}
	maxLayer, layered := layout["maxLayer"].(float64)
	m, mIsNumber := layout["m"].(float64)
	if !layered || !mIsNumber {
		return coldGraphLayout{}, false, coldLoadFailed(`The head of "`+ref.Key+`" holds no layers`, ref.Key)
	}
	if whole, isWhole := wholeNumber(m); !isWhole || whole < payload.MinM || whole > payload.MaxM {
		return coldGraphLayout{}, false, coldLoadFailed(`The head of "`+ref.Key+`" gives m `+
			strconv.FormatFloat(m, 'f', -1, 64)+`, while m must be a whole number from `+strconv.Itoa(payload.MinM)+
			` to `+strconv.Itoa(payload.MaxM), ref.Key)
	}
	entryPoint := -1
	if entry, present := layout["entryPoint"]; present && entry != nil {
		if _, isNumber := entry.(float64); !isNumber {
			return coldGraphLayout{}, false, coldLoadFailed(`The head of "`+ref.Key+`" holds no entry`, ref.Key)
		}
		entryPoint = graphNumberOf(entry)
	}
	levelBytes, err := paged.ReadSectionChecked(source.reader, levels, ref.Key)
	if err != nil {
		return coldGraphLayout{}, false, err
	}
	return coldGraphLayout{m: int(m), levels: levelBytes, entryPoint: entryPoint,
		maxLayer: layerOf(maxLayer), nodeOffsets: nodeOffsets,
		neighbours: neighbours}, true, nil
}

func requireColdField(ctx context.Context, store checkpoint.Store, ref manifest.VectorFieldRef) error {
	for _, file := range ref.Files {
		cold, err := requireColdFile(ctx, store, file)
		if err != nil || !cold {
			return err
		}
	}
	var parts []payload.NumberedGraph
	m := 0
	for _, partRef := range ref.GraphParts {
		layout, cold, err := requireColdGraphPart(ctx, store, partRef)
		if err != nil {
			return err
		}
		if !cold {
			return nil
		}
		if len(parts) == 0 {
			m = layout.m
		}
		parts = append(parts, payload.NumberedGraph{M: m, Levels: layout.levels})
	}
	if len(parts) == 0 {
		return nil
	}
	return payload.RequireBoundedUpperLists(payload.GraphParts{FieldName: ref.FieldPath,
		Graphs: []payload.NumberedGraphParts{{Parts: parts}}})
}
