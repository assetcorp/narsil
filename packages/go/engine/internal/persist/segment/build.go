package segment

import (
	"encoding/binary"
	"math"
	"slices"
	"strings"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/keyword"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partition"
)

type chunk struct {
	ordinals            []uint32
	ids                 []byte
	idOffsets           []byte
	documents           []byte
	documentOffsets     []byte
	tokens              []byte
	tokenOffsets        []byte
	documentFrequencies []byte
	postingOffsets      []byte
	postingDocuments    []byte
	postingFrequencies  []byte
	postingFields       []byte
	positionOffsets     []byte
	positions           []byte
	postingCount        uint32
	positionCount       uint32
	tokenOpen           bool
	tokenUnique         uint32
	tracksPositions     bool
	fieldLengthColumns  []keyword.FieldLengthColumn
	lengths             [][]byte
	numeric             []keyword.ValueColumn
	sizes               []keyword.ValueColumn
	boolean             []keyword.BooleanColumn
	enum                []keyword.EnumColumn
	geopoint            []keyword.GeopointColumn
}

type layout struct {
	source      source
	chunkOf     []int32
	localOf     []uint32
	chunks      []*chunk
	seenWith    []uint32
	lengthNames []string
}

func appendUint32(destination []byte, value uint32) []byte {
	return binary.LittleEndian.AppendUint32(destination, value)
}

func appendUint16(destination []byte, value uint16) []byte {
	return binary.LittleEndian.AppendUint16(destination, value)
}

func estimatedBytes(document *partition.StoredDocument, encoded int) int64 {
	tokens := int64(0)
	for _, length := range document.FieldLengths {
		tokens += int64(length)
	}
	return int64(encoded) + tokens*estimatedBytesPerToken + estimatedBytesPerDocument
}

func newLayout(held source, targetBytes int64) (*layout, error) {
	plan := &layout{
		source:      held,
		chunkOf:     make([]int32, held.capacity),
		localOf:     make([]uint32, held.capacity),
		seenWith:    make([]uint32, held.capacity),
		lengthNames: sortedPaths(held.totalFieldLengths),
	}
	for at := range plan.chunkOf {
		plan.chunkOf[at] = -1
	}
	current := &chunk{idOffsets: appendUint32(nil, 0), documentOffsets: appendUint32(nil, 0)}
	plan.chunks = append(plan.chunks, current)
	var currentBytes int64
	for ordinal := range held.capacity {
		document, err := held.documentAt(ordinal)
		if err != nil {
			return nil, err
		}
		if document == nil {
			continue
		}
		encoded, err := codec.EncodeDocument(document.Fields)
		if err != nil {
			return nil, err
		}
		bytes := estimatedBytes(document, len(encoded))
		offsetsOverflow := uint64(len(current.documents))+uint64(len(encoded)) > math.MaxUint32 ||
			uint64(len(current.ids))+uint64(len(document.ID)) > math.MaxUint32
		if len(current.ordinals) > 0 && (currentBytes+bytes > targetBytes || offsetsOverflow) {
			current = &chunk{idOffsets: appendUint32(nil, 0), documentOffsets: appendUint32(nil, 0)}
			plan.chunks = append(plan.chunks, current)
			currentBytes = 0
		}
		currentBytes += bytes
		plan.chunkOf[ordinal] = int32(len(plan.chunks) - 1)
		plan.localOf[ordinal] = uint32(len(current.ordinals))
		current.ordinals = append(current.ordinals, ordinal)
		plan.noteLengths(current, document)
		current.ids = append(current.ids, document.ID...)
		current.idOffsets = appendUint32(current.idOffsets, uint32(len(current.ids)))
		current.documents = append(current.documents, encoded...)
		current.documentOffsets = appendUint32(current.documentOffsets, uint32(len(current.documents)))
	}
	return plan, nil
}

func (plan *layout) postings() error {
	tokens := slices.Clone(plan.source.tokens)
	slices.SortFunc(tokens, strings.Compare)
	tracksPositions := plan.source.tracksPositions
	for _, current := range plan.chunks {
		current.tokenOffsets = appendUint32(nil, 0)
		current.postingOffsets = appendUint32(nil, 0)
		current.tracksPositions = tracksPositions
		if tracksPositions {
			current.positionOffsets = []byte{}
			current.positions = []byte{}
		}
	}
	var touched []*chunk
	for at, token := range tokens {
		list, found, err := plan.source.lookup(token)
		if err != nil {
			return err
		}
		if !found {
			continue
		}
		stamp := uint32(at + 1)
		touched = touched[:0]
		for row, ordinal := range list.DocIDs {
			owner, held := plan.owner(ordinal)
			if !held {
				continue
			}
			current := plan.chunks[owner]
			if !current.tokenOpen {
				current.tokenOpen = true
				current.tokenUnique = 0
				touched = append(touched, current)
				current.tokens = append(current.tokens, token...)
				current.tokenOffsets = appendUint32(current.tokenOffsets, uint32(len(current.tokens)))
			}
			if plan.seenWith[ordinal] != stamp {
				plan.seenWith[ordinal] = stamp
				current.tokenUnique++
			}
			current.postingDocuments = appendUint32(current.postingDocuments, plan.localOf[ordinal])
			current.postingFrequencies = appendUint16(current.postingFrequencies, list.Frequencies[row])
			current.postingFields = appendUint16(current.postingFields, list.Fields[row])
			if tracksPositions {
				current.positionOffsets = appendUint32(current.positionOffsets, current.positionCount)
				for _, position := range list.PositionsAt(row) {
					current.positions = appendUint32(current.positions, position)
					current.positionCount++
				}
			}
			current.postingCount++
		}
		for _, current := range touched {
			current.tokenOpen = false
			current.documentFrequencies = appendUint32(current.documentFrequencies, current.tokenUnique)
			current.postingOffsets = appendUint32(current.postingOffsets, current.postingCount)
		}
	}
	if tracksPositions {
		for _, current := range plan.chunks {
			current.positionOffsets = appendUint32(current.positionOffsets, current.positionCount)
		}
	}
	return nil
}

func idOrder(current *chunk) keyword.Uint32s {
	order := make([]uint32, len(current.ordinals))
	for at := range order {
		order[at] = uint32(at)
	}
	offsets := keyword.Uint32s(current.idOffsets)
	idAt := func(local uint32) string {
		return string(current.ids[offsets.At(int(local)):offsets.At(int(local)+1)])
	}
	slices.SortFunc(order, func(left, right uint32) int { return strings.Compare(idAt(left), idAt(right)) })
	encoded := make([]byte, 0, len(order)*4)
	for _, local := range order {
		encoded = appendUint32(encoded, local)
	}
	return encoded
}
