package archive

import (
	"errors"
	"io"
	"sort"

	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type LayoutFile struct {
	Name   string
	Bytes  int64
	Source io.ReaderAt
}

type Part struct {
	Start  int64
	Length int64
	Inline []byte
	File   *LayoutFile
}

type Layout struct {
	Parts      []Part
	ByteLength int64
}

type layoutBuilder struct {
	parts []Part
	at    int64
}

func (builder *layoutBuilder) inline(data []byte) {
	if len(data) == 0 {
		return
	}
	builder.parts = append(builder.parts, Part{Start: builder.at, Length: int64(len(data)), Inline: data})
	builder.at += int64(len(data))
}

func (builder *layoutBuilder) headers(name string, size int64) error {
	headers, err := EntryHeaders(name, size)
	if err != nil {
		return err
	}
	for _, header := range headers {
		builder.inline(header)
	}
	return nil
}

func NewLayout(config []byte, manifest []byte, files []LayoutFile) (Layout, error) {
	builder := &layoutBuilder{}
	files = append([]LayoutFile(nil), files...)
	for _, entry := range []struct {
		name string
		data []byte
	}{{ConfigEntry, config}, {ManifestEntry, manifest}} {
		if err := builder.headers(entry.name, int64(len(entry.data))); err != nil {
			return Layout{}, err
		}
		builder.inline(entry.data)
		builder.inline(make([]byte, Padding(int64(len(entry.data)))))
	}
	for index := range files {
		file := &files[index]
		if file.Source == nil && file.Bytes > 0 {
			return Layout{}, saveFailed("the file \""+file.Name+"\" has no source", map[string]any{"entry": file.Name})
		}
		if err := builder.headers(file.Name, file.Bytes); err != nil {
			return Layout{}, err
		}
		if file.Bytes > 0 {
			builder.parts = append(builder.parts, Part{Start: builder.at, Length: file.Bytes, File: file})
			builder.at += file.Bytes
		}
		builder.inline(make([]byte, Padding(file.Bytes)))
	}
	builder.inline(EndBlocks())
	return Layout{Parts: builder.parts, ByteLength: builder.at}, nil
}

func EstimatedBytes(fileBytes []int64) int64 {
	var total int64
	for _, bytes := range fileBytes {
		total += bytes + EntryEstimateBytes
	}
	return total
}

func (layout Layout) WriteRange(destination io.Writer, start int64, endExclusive int64) error {
	end := min(endExclusive, layout.ByteLength)
	if start < 0 || start >= end {
		return nil
	}
	first := sort.Search(len(layout.Parts), func(index int) bool { return layout.Parts[index].Start > start }) - 1
	first = max(first, 0)
	var buffer []byte
	for _, part := range layout.Parts[first:] {
		if part.Start >= end {
			return nil
		}
		from := max(start, part.Start) - part.Start
		to := min(end, part.Start+part.Length) - part.Start
		if part.File == nil {
			if err := writeChunk(destination, part.Inline[from:to]); err != nil {
				return err
			}
			continue
		}
		if wanted := min(int64(FileChunkBytes), to-from); int64(len(buffer)) < wanted {
			buffer = make([]byte, wanted)
		}
		if err := copyFileRange(destination, part.File, from, to, buffer); err != nil {
			return err
		}
	}
	return nil
}

func copyFileRange(destination io.Writer, file *LayoutFile, from int64, to int64, buffer []byte) error {
	for offset := from; offset < to; {
		length := min(int64(len(buffer)), to-offset)
		chunk := buffer[:length]
		read, err := file.Source.ReadAt(chunk, offset)
		if int64(read) != length {
			if err != nil && !errors.Is(err, io.EOF) {
				return narsilerr.Wrap(narsilerr.CodePersistenceLoadFailed,
					"The archive file \""+file.Name+"\" fails to read", err, map[string]any{"name": file.Name, "offset": offset})
			}
			return narsilerr.New(narsilerr.CodePersistenceLoadFailed,
				"The archive file \""+file.Name+"\" ends before the bytes that its manifest lists",
				map[string]any{"name": file.Name, "offset": offset, "length": length})
		}
		if err := writeChunk(destination, chunk); err != nil {
			return err
		}
		offset += length
	}
	return nil
}

func writeChunk(destination io.Writer, chunk []byte) error {
	if _, err := destination.Write(chunk); err != nil {
		return narsilerr.Wrap(narsilerr.CodePersistenceSaveFailed,
			"The snapshot archive cannot be written: the destination fails to take bytes", err, nil)
	}
	return nil
}
