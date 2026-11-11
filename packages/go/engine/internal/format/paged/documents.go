package paged

import (
	"bytes"
	"compress/flate"
	"encoding/binary"
	"errors"
	"io"
	"unicode/utf8"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/form"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/keyword"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type loadedBlock struct {
	block  int
	raw    []byte
	starts []int
}

func (reader *Reader) blockCount() int {
	return len(reader.Resident.DocumentBlocks) / DocumentBlockBytes
}

func (reader *Reader) blockOf(ordinal uint32) int {
	blocks := reader.Resident.DocumentBlocks
	low, high := 0, reader.blockCount()
	for high-low > 1 {
		middle := (low + high) / 2
		if binary.LittleEndian.Uint32(blocks[middle*DocumentBlockBytes:]) <= ordinal {
			low = middle
		} else {
			high = middle
		}
	}
	return low
}

func InflateBlock(compressed []byte, rawLength uint32) ([]byte, error) {
	inflater := flate.NewReader(bytes.NewReader(compressed))
	defer inflater.Close()
	raw := make([]byte, rawLength)
	if _, err := io.ReadFull(inflater, raw); err != nil {
		return nil, err
	}
	var probe [1]byte
	read, err := inflater.Read(probe[:])
	if read > 0 {
		return nil, errors.New("the block inflates past its raw length")
	}
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	return raw, nil
}

func (reader *Reader) loadBlock(block int) (*loadedBlock, error) {
	first, offset, length, rawLength := documentBlockAt(reader.Resident.DocumentBlocks, block)
	if rawLength > MaxDocumentBlockRawBytes {
		return nil, loadFailed("Document block "+itoaInt(block)+" of the "+what+" claims more raw bytes than the limit",
			map[string]any{"block": block, "rawLength": rawLength})
	}
	section, err := reader.Section("documents")
	if err != nil {
		return nil, err
	}
	compressed, err := reader.ReadSection(section, int64(offset), int64(length))
	if err != nil {
		return nil, err
	}
	raw, err := InflateBlock(compressed, rawLength)
	if err != nil {
		return nil, narsilerr.Wrap(narsilerr.CodePersistenceLoadFailed,
			"Document block "+itoaInt(block)+" of the "+what+" fails to inflate: "+err.Error(), err,
			map[string]any{"block": block})
	}
	end := reader.Head.DocumentCount
	if block+1 < reader.blockCount() {
		end, _, _, _ = documentBlockAt(reader.Resident.DocumentBlocks, block+1)
	}
	if uint64(end-first) > uint64(len(raw)) {
		return nil, loadFailed("Document block "+itoaInt(block)+" of the "+what+" claims more documents than its bytes hold",
			map[string]any{"block": block})
	}
	starts := make([]int, 0, min(int(end-first)+1, InitialBlockStarts))
	decoder := codec.NewDecoder(raw, codec.DecodeOptions{ErrorCode: narsilerr.CodePersistenceLoadFailed})
	for at := first; at < end; at++ {
		starts = append(starts, decoder.Position())
		if !decoder.More() || decoder.Skip() != nil {
			return nil, loadFailed("Document block "+itoaInt(block)+" of the "+what+" holds a broken document",
				map[string]any{"block": block})
		}
	}
	starts = append(starts, decoder.Position())
	if decoder.More() {
		return nil, loadFailed("Document block "+itoaInt(block)+" of the "+what+" holds bytes past its documents",
			map[string]any{"block": block})
	}
	return &loadedBlock{block: block, raw: raw, starts: starts}, nil
}

func (block *loadedBlock) heldBytes() int64 {
	return int64(len(block.raw) + len(block.starts)*8)
}

func (reader *Reader) heldBlockOf(block int) (*loadedBlock, error) {
	file := reader.cached
	if file != nil {
		if held, found := file.cache.Get(file.number, CachedDocumentBlock, int64(block)); found {
			if loaded, isBlock := held.(*loadedBlock); isBlock {
				return loaded, nil
			}
		}
		loaded, err := reader.loadBlock(block)
		if err != nil {
			return nil, err
		}
		if !file.closed.Load() {
			file.cache.Put(file.number, CachedDocumentBlock, int64(block), loaded, loaded.heldBytes())
		}
		return loaded, nil
	}
	reader.blockMutex.Lock()
	held := reader.heldBlock
	reader.blockMutex.Unlock()
	if held != nil && held.block == block {
		return held, nil
	}
	loaded, err := reader.loadBlock(block)
	if err != nil {
		return nil, err
	}
	reader.blockMutex.Lock()
	reader.heldBlock = loaded
	reader.blockMutex.Unlock()
	return loaded, nil
}

func (reader *Reader) EncodedDocument(ordinal uint32) ([]byte, error) {
	if ordinal >= reader.Head.DocumentCount {
		return nil, loadFailed("A document lies outside the "+what, map[string]any{"ordinal": ordinal})
	}
	block := reader.blockOf(ordinal)
	held, err := reader.heldBlockOf(block)
	if err != nil {
		return nil, err
	}
	first, _, _, _ := documentBlockAt(reader.Resident.DocumentBlocks, block)
	row := int(ordinal - first)
	return held.raw[held.starts[row]:held.starts[row+1]], nil
}

func (reader *Reader) Document(ordinal uint32) (map[string]any, error) {
	encoded, err := reader.EncodedDocument(ordinal)
	if err != nil {
		return nil, err
	}
	document, err := codec.DecodeDocument(encoded, codec.DecodeOptions{ErrorCode: narsilerr.CodePersistenceLoadFailed})
	if err != nil {
		return nil, narsilerr.Wrap(narsilerr.CodePersistenceLoadFailed,
			"Document "+itoaInt(int(ordinal))+" of the "+what+" is not a MessagePack map", err,
			map[string]any{"ordinal": ordinal})
	}
	return document, nil
}

func (reader *Reader) IDBytes(ordinal uint32) ([]byte, error) {
	offsets, err := reader.Section("idOffsets")
	if err != nil {
		return nil, err
	}
	ids, err := reader.Section("ids")
	if err != nil {
		return nil, err
	}
	bounds, err := reader.ReadSection(offsets, int64(ordinal)*4, 8)
	if err != nil {
		return nil, err
	}
	from := int64(binary.LittleEndian.Uint32(bounds))
	to := int64(binary.LittleEndian.Uint32(bounds[4:]))
	if to < from || to > ids.Length || (ordinal == 0 && from != 0) ||
		(ordinal+1 == reader.Head.DocumentCount && to != ids.Length) {
		return nil, loadFailed("The ID of a document of the "+what+" leaves its list", map[string]any{"ordinal": ordinal})
	}
	id, err := reader.ReadSection(ids, from, to-from)
	if err != nil {
		return nil, err
	}
	if !utf8.Valid(id) {
		return nil, loadFailed("The ID of a document of the "+what+" is not valid UTF-8", map[string]any{"ordinal": ordinal})
	}
	return id, nil
}

func (reader *Reader) SortedOrdinal(position uint32) (uint32, error) {
	section, err := reader.Section("idOrder")
	if err != nil {
		return 0, err
	}
	ordinal, err := reader.uint32At(section, int64(position))
	if err != nil {
		return 0, err
	}
	if ordinal >= reader.Head.DocumentCount {
		return 0, loadFailed("idOrder of the "+what+" names a document past its count", map[string]any{"position": position})
	}
	return ordinal, nil
}

func (reader *Reader) RemovalEntry(ordinal uint32) (keyword.Uint32s, error) {
	offsets, err := reader.Section("removalOffsets")
	if err != nil {
		return nil, err
	}
	removals, err := reader.Section("removals")
	if err != nil {
		return nil, err
	}
	bounds, err := reader.ReadSection(offsets, int64(ordinal)*4, 8)
	if err != nil {
		return nil, err
	}
	from := int64(binary.LittleEndian.Uint32(bounds))
	to := int64(binary.LittleEndian.Uint32(bounds[4:]))
	if to < from || to*4 > removals.Length || from%2 != 0 || to%2 != 0 {
		return nil, loadFailed("The removal entry of a document of the "+what+" leaves its list",
			map[string]any{"ordinal": ordinal})
	}
	entry, err := reader.ReadSection(removals, from*4, (to-from)*4)
	if err != nil {
		return nil, err
	}
	values := keyword.Uint32s(entry)
	tokenCount := uint32(reader.TokenCount())
	for at := 0; at < values.Len(); at += 2 {
		if values.At(at) >= tokenCount {
			return nil, loadFailed("The removal entry of a document of the "+what+" lists a token past the token count",
				map[string]any{"ordinal": ordinal})
		}
	}
	return values, nil
}

func (reader *Reader) WriteRecord(ordinal uint32) (seqNo uint64, primaryTerm uint64, held bool, err error) {
	seqNos, hasSeqNos := reader.Head.Section("seqNos")
	primaryTerms, hasPrimaryTerms := reader.Head.Section("primaryTerms")
	if !hasSeqNos || !hasPrimaryTerms {
		return 0, 0, false, nil
	}
	values := [2]uint64{}
	for at, section := range []Section{seqNos, primaryTerms} {
		bytes, readErr := reader.ReadSection(section, int64(ordinal)*8, 8)
		if readErr != nil {
			return 0, 0, false, readErr
		}
		values[at] = binary.LittleEndian.Uint64(bytes)
		if values[at] > form.MaxSafeInteger {
			return 0, 0, false, loadFailed("A write record of the "+what+" lies above 2^53 - 1",
				map[string]any{"ordinal": ordinal})
		}
	}
	return values[0], values[1], true, nil
}

func (reader *Reader) SurfaceForms() (*keyword.SurfaceFormColumn, error) {
	if _, ok := reader.Head.Section("surfaceForms"); !ok {
		return nil, nil
	}
	raw, err := reader.packedSection("surfaceForms")
	if err != nil {
		return nil, err
	}
	checker := keyword.NewChecker("Invalid paged keyword segment: ")
	column := checker.ParseSurfaceForms(raw)
	checker.CheckSurfaceForms(column)
	if checker.Failed() {
		return nil, checker.Err()
	}
	return column, nil
}
