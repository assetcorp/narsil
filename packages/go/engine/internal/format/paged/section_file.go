package paged

import (
	"io"
	"strconv"
	"sync/atomic"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type File struct {
	source io.ReaderAt
	key    string
	number uint64
	cache  *ReadCache
	closed atomic.Bool
}

func OpenFile(source io.ReaderAt, key string, cache *ReadCache) *File {
	return &File{source: source, key: key, number: cache.FileNumber(), cache: cache}
}

func (file *File) Key() string {
	return file.key
}

func (file *File) Close() {
	if file.closed.Swap(true) {
		return
	}
	file.cache.ReleaseFile(file.number)
}

type SectionReader struct {
	file    *File
	section Section
}

func (file *File) Section(section Section) SectionReader {
	return SectionReader{file: file, section: section}
}

func (reader SectionReader) Length() int64 {
	return reader.section.Length
}

func (reader SectionReader) requireInside(position int64, size int64) error {
	if position >= 0 && size >= 0 && position+size <= reader.section.Length {
		return nil
	}
	return narsilerr.New(narsilerr.CodePersistenceLoadFailed,
		"A read of "+strconv.FormatInt(size, 10)+" bytes at "+strconv.FormatInt(position, 10)+
			` ends outside section "`+reader.section.Name+`" of "`+reader.file.key+`"`,
		map[string]any{"key": reader.file.key, "section": reader.section.Name, "position": position, "size": size,
			"length": reader.section.Length})
}

func (reader SectionReader) page(page int64) ([]byte, error) {
	section := reader.section
	entry := envelope.HeaderBytes + section.Offset + page*section.PageBytes
	file := reader.file
	if held, found := file.cache.Get(file.number, CachedPage, entry); found {
		if bytes, isBytes := held.([]byte); isBytes {
			return bytes, nil
		}
	}
	data := make([]byte, min(section.PageBytes, section.Length-page*section.PageBytes))
	if err := readPageOf(file.source, section, page, data, file.key); err != nil {
		return nil, err
	}
	if !file.closed.Load() {
		file.cache.Put(file.number, CachedPage, entry, data, int64(len(data)))
	}
	return data, nil
}

func (reader SectionReader) Read(position int64, target []byte) error {
	if err := reader.requireInside(position, int64(len(target))); err != nil {
		return err
	}
	pageBytes := reader.section.PageBytes
	written := 0
	for written < len(target) {
		at := position + int64(written)
		page := at / pageBytes
		data, err := reader.page(page)
		if err != nil {
			return err
		}
		from := at - page*pageBytes
		written += copy(target[written:], data[from:])
	}
	return nil
}

func (reader SectionReader) BytesAt(position int64, size int64) ([]byte, error) {
	if err := reader.requireInside(position, size); err != nil {
		return nil, err
	}
	if size == 0 {
		return []byte{}, nil
	}
	pageBytes := reader.section.PageBytes
	page := position / pageBytes
	from := position - page*pageBytes
	if from+size <= pageBytes {
		data, err := reader.page(page)
		if err != nil {
			return nil, err
		}
		return data[from : from+size : from+size], nil
	}
	target := make([]byte, size)
	if err := reader.Read(position, target); err != nil {
		return nil, err
	}
	return target, nil
}

func (reader SectionReader) Whole() ([]byte, error) {
	target := make([]byte, reader.section.Length)
	if err := reader.Read(0, target); err != nil {
		return nil, err
	}
	return target, nil
}
