package vector

import (
	"context"
	"encoding/binary"
	"math"
	"strconv"
	"sync"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type ColdSection interface {
	Length() int64
	Read(position int64, target []byte) error
	BytesAt(position int64, size int64) ([]byte, error)
}

type ColdGraphFile struct {
	Key       string
	Count     int
	Dead      []byte
	IDs       ColdSection
	IDOffsets ColdSection
	IDOrder   ColdSection
	Records   ColdSection
	Vectors   ColdSection
}

type ColdGraphPart struct {
	Levels      []byte
	NodeOffsets []uint32
	Neighbours  ColdSection
}

type ColdGraphInput struct {
	Dimension        int
	CodeBits         uint32
	Centroid         []float32
	Files            []ColdGraphFile
	Parts            []ColdGraphPart
	EntryPoint       int
	MaxLayer         int
	ResolvePartition func(docID string) (int32, bool)
	FilePaths        []string
	Close            func()
}

type coldGraphField struct {
	input        ColdGraphInput
	firstNumbers []int
	total        int
	live         int
	resident     int
	closeOnce    sync.Once
}

func coldReadFailed(message string, key string) error {
	return narsilerr.New(narsilerr.CodePersistenceLoadFailed, message, map[string]any{"key": key})
}

func everyLiveVectorHoldsANode(input ColdGraphInput, firstNumbers []int) bool {
	for at, file := range input.Files {
		for position := range file.Count {
			if isDead(file.Dead, position) {
				continue
			}
			number := firstNumbers[at] + position
			part := number / coldGraphPartVectors
			if part >= len(input.Parts) {
				return false
			}
			levels := input.Parts[part].Levels
			if offset := number % coldGraphPartVectors; offset >= len(levels) || levels[offset] == 0 {
				return false
			}
		}
	}
	return true
}

func NewColdGraphField(input ColdGraphInput) (ColdVectorField, bool) {
	firstNumbers := make([]int, len(input.Files))
	total := 0
	live := 0
	for at, file := range input.Files {
		firstNumbers[at] = total
		total += file.Count
		for position := range file.Count {
			if !isDead(file.Dead, position) {
				live++
			}
		}
	}
	if !everyLiveVectorHoldsANode(input, firstNumbers) {
		return nil, false
	}
	resident := 0
	for _, part := range input.Parts {
		resident += len(part.Levels) + len(part.NodeOffsets)*coldIDOffsetEntryBytes
	}
	return &coldGraphField{input: input, firstNumbers: firstNumbers, total: total, live: live, resident: resident},
		true
}

func (c *coldGraphField) fileOfNumber(number int) int {
	low, high := 0, len(c.firstNumbers)-1
	for low < high {
		middle := (low + high + 1) >> 1
		if c.firstNumbers[middle] <= number {
			low = middle
		} else {
			high = middle - 1
		}
	}
	return low
}

func (c *coldGraphField) topLayerOf(number int) int {
	part := number / coldGraphPartVectors
	if number < 0 || part >= len(c.input.Parts) {
		return -1
	}
	levels := c.input.Parts[part].Levels
	if offset := number % coldGraphPartVectors; offset < len(levels) {
		return int(levels[offset]) - 1
	}
	return -1
}

func (c *coldGraphField) idInFile(file ColdGraphFile, position int) (string, error) {
	var offsets [2 * coldIDOffsetEntryBytes]byte
	if err := file.IDOffsets.Read(int64(position)*coldIDOffsetEntryBytes, offsets[:]); err != nil {
		return "", err
	}
	start := binary.LittleEndian.Uint32(offsets[:])
	end := binary.LittleEndian.Uint32(offsets[coldIDOffsetEntryBytes:])
	if end < start {
		return "", coldReadFailed(`The ID offsets of "`+file.Key+`" descend at position `+strconv.Itoa(position),
			file.Key)
	}
	encoded, err := file.IDs.BytesAt(int64(start), int64(end-start))
	if err != nil {
		return "", err
	}
	decoded, err := codec.Unmarshal(encoded, codec.DecodeOptions{ErrorCode: narsilerr.CodePersistenceLoadFailed})
	id, isString := decoded.(string)
	if err != nil || !isString {
		return "", coldReadFailed(`Position `+strconv.Itoa(position)+` of "`+file.Key+`" holds no ID`, file.Key)
	}
	return id, nil
}

func (c *coldGraphField) idAt(number int) (string, error) {
	at := c.fileOfNumber(number)
	return c.idInFile(c.input.Files[at], number-c.firstNumbers[at])
}

func (c *coldGraphField) readVector(number int, target []float32, scratch []byte) error {
	at := c.fileOfNumber(number)
	stride := int64(c.input.Dimension) * coldVectorComponentBytes
	if err := c.input.Files[at].Vectors.Read(int64(number-c.firstNumbers[at])*stride, scratch); err != nil {
		return err
	}
	for component := range target {
		target[component] = math.Float32frombits(binary.LittleEndian.Uint32(scratch[component*coldVectorComponentBytes:]))
	}
	return nil
}

func (c *coldGraphField) isDeadNumber(number int) bool {
	at := c.fileOfNumber(number)
	return isDead(c.input.Files[at].Dead, number-c.firstNumbers[at])
}

func (c *coldGraphField) positionOfID(at int, docID string) (int, bool, error) {
	file := c.input.Files[at]
	var slot [coldIDOffsetEntryBytes]byte
	low, high := 0, file.Count-1
	for low <= high {
		middle := (low + high) >> 1
		if err := file.IDOrder.Read(int64(middle)*coldIDOffsetEntryBytes, slot[:]); err != nil {
			return 0, false, err
		}
		position := int(binary.LittleEndian.Uint32(slot[:]))
		if position >= file.Count {
			return 0, false, coldReadFailed(`The ID order of "`+file.Key+`" holds position `+strconv.Itoa(position),
				file.Key)
		}
		id, err := c.idInFile(file, position)
		if err != nil {
			return 0, false, err
		}
		switch order := text.CompareCodePoints(id, docID); {
		case order == 0:
			return position, true, nil
		case order < 0:
			low = middle + 1
		default:
			high = middle - 1
		}
	}
	return 0, false, nil
}

func (c *coldGraphField) LiveCount() int {
	return c.live
}

func (c *coldGraphField) ResidentBytes() int {
	return c.resident
}

func (c *coldGraphField) NumberOf(docID string) (int, bool) {
	for at := len(c.input.Files) - 1; at >= 0; at-- {
		position, found, err := c.positionOfID(at, docID)
		if err != nil {
			return 0, false
		}
		if found && !isDead(c.input.Files[at].Dead, position) {
			return c.firstNumbers[at] + position, true
		}
	}
	return 0, false
}

func (c *coldGraphField) VectorOfNumber(number int) ([]float32, error) {
	if number < 0 || number >= c.total {
		return nil, coldReadFailed("Vector "+strconv.Itoa(number)+" lies outside the vector files", "")
	}
	values := make([]float32, c.input.Dimension)
	if err := c.readVector(number, values, make([]byte, len(values)*coldVectorComponentBytes)); err != nil {
		return nil, err
	}
	return values, nil
}

func (c *coldGraphField) PartitionOf(docID string) (int32, bool) {
	if c.input.ResolvePartition == nil {
		return 0, false
	}
	return c.input.ResolvePartition(docID)
}

func (c *coldGraphField) FilePaths() []string {
	return append([]string(nil), c.input.FilePaths...)
}

func (c *coldGraphField) Search(ctx context.Context, query []float32, k int, options SearchOptions,
	admits func(docID string) bool, excluded map[int]struct{}) ([]ScoredResult, error) {
	return c.walk(ctx, query, k, options, admits, excluded)
}

func (c *coldGraphField) Close() {
	c.closeOnce.Do(func() {
		if c.input.Close != nil {
			c.input.Close()
		}
	})
}
