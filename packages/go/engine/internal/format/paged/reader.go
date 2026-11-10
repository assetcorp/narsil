package paged

import (
	"encoding/binary"
	"errors"
	"io"
	"strconv"
	"sync"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type Reader struct {
	source        io.ReaderAt
	size          int64
	Header        envelope.Header
	Head          Head
	PayloadLength int64
	Resident      Resident
	blockMutex    sync.Mutex
	heldBlock     *loadedBlock
	cached        *File
}

const what = "paged keyword segment"

func (reader *Reader) readAt(offset int64, target []byte) error {
	read, err := reader.source.ReadAt(target, offset)
	if read == len(target) {
		return nil
	}
	if err == nil || errors.Is(err, io.EOF) {
		err = io.ErrUnexpectedEOF
	}
	return narsilerr.Wrap(narsilerr.CodePersistenceLoadFailed,
		"The "+what+" cannot be read at byte "+strconv.FormatInt(offset, 10), err,
		map[string]any{"offset": offset, "length": len(target)})
}

func OpenCached(source io.ReaderAt, size int64, key string, cache *ReadCache) (*Reader, error) {
	cached := OpenFile(source, key, cache)
	reader, err := Open(source, size)
	if err != nil {
		cached.Close()
		return nil, err
	}
	reader.cached = cached
	return reader, nil
}

func (reader *Reader) Close() {
	if reader.cached != nil {
		reader.cached.Close()
	}
}

func Open(source io.ReaderAt, size int64) (*Reader, error) {
	reader := &Reader{source: source, size: size}
	if size < envelope.HeaderBytes+PayloadPrefixBytes {
		return nil, loadFailed("The "+what+" is too short to hold a head", map[string]any{"bytes": size})
	}
	start := make([]byte, envelope.HeaderBytes+PayloadPrefixBytes)
	if err := reader.readAt(0, start); err != nil {
		return nil, err
	}
	header, err := envelope.ParseHeader(start)
	if err != nil {
		return nil, err
	}
	if err := requireHeader(header, size); err != nil {
		return nil, err
	}
	reader.Header = header
	reader.PayloadLength = int64(header.PayloadLength)
	headLength := int64(binary.LittleEndian.Uint32(start[envelope.HeaderBytes:]))
	headChecksum := binary.LittleEndian.Uint32(start[envelope.HeaderBytes+4:])
	if PayloadPrefixBytes+headLength > reader.PayloadLength {
		return nil, loadFailed("The head of the "+what+" ends outside its payload",
			map[string]any{"headLength": headLength})
	}
	encodedHead := make([]byte, headLength)
	if err := reader.readAt(envelope.HeaderBytes+PayloadPrefixBytes, encodedHead); err != nil {
		return nil, err
	}
	if codec.CRC32(encodedHead) != headChecksum {
		return nil, narsilerr.New(narsilerr.CodePersistenceCrcMismatch, "The head of the "+what+" fails its checksum", nil)
	}
	reader.Head, err = DecodeHead(encodedHead, reader.PayloadLength, "the "+what)
	if err != nil {
		return nil, err
	}
	if err := reader.readResident(); err != nil {
		return nil, err
	}
	return reader, nil
}

func requireHeader(header envelope.Header, size int64) error {
	if header.FormatVersion != EnvelopeVersion {
		return narsilerr.New(narsilerr.CodeEnvelopeVersionMismatch,
			"The "+what+" holds envelope format v"+strconv.Itoa(int(header.FormatVersion))+", while this build reads it as v6",
			map[string]any{"version": header.FormatVersion})
	}
	if header.Encrypted() {
		return narsilerr.New(narsilerr.CodeEnvelopeVersionMismatch, "The "+what+" is encrypted, which this build cannot read", nil)
	}
	if header.Compressed() {
		return loadFailed("The "+what+" is compressed, while its format stores it raw", nil)
	}
	if !header.HasChecksum() {
		return loadFailed("The "+what+" carries no checksum, while its format requires one", nil)
	}
	if int64(envelope.HeaderBytes)+int64(header.PayloadLength) != size {
		return loadFailed("The "+what+" holds "+strconv.FormatInt(size, 10)+" bytes where its header gives "+
			strconv.FormatInt(int64(envelope.HeaderBytes)+int64(header.PayloadLength), 10), map[string]any{"bytes": size})
	}
	return nil
}

func (reader *Reader) Section(name string) (Section, error) {
	section, ok := reader.Head.Section(name)
	if !ok {
		return Section{}, loadFailed("The "+what+" holds no section \""+name+"\"", map[string]any{"section": name})
	}
	return section, nil
}

func pageChecksum(section Section, page int64) uint32 {
	return binary.LittleEndian.Uint32(section.Checksums[page*pageChecksumBytes:])
}

func (reader *Reader) ReadSection(section Section, position int64, length int64) ([]byte, error) {
	if position < 0 || length < 0 || position+length > section.Length {
		return nil, loadFailed("A read of "+strconv.FormatInt(length, 10)+" bytes at "+strconv.FormatInt(position, 10)+
			" ends outside section \""+section.Name+"\"", map[string]any{"section": section.Name})
	}
	if length == 0 {
		return []byte{}, nil
	}
	if reader.cached != nil {
		target := make([]byte, length)
		if err := reader.cached.Section(section).Read(position, target); err != nil {
			return nil, err
		}
		return target, nil
	}
	firstPage := position / section.PageBytes
	lastPage := (position + length - 1) / section.PageBytes
	spanStart := firstPage * section.PageBytes
	spanEnd := min((lastPage+1)*section.PageBytes, section.Length)
	span := make([]byte, spanEnd-spanStart)
	if err := reader.readAt(envelope.HeaderBytes+section.Offset+spanStart, span); err != nil {
		return nil, err
	}
	for page := firstPage; page <= lastPage; page++ {
		from := page*section.PageBytes - spanStart
		to := min(from+section.PageBytes, int64(len(span)))
		if codec.CRC32(span[from:to]) != pageChecksum(section, page) {
			return nil, narsilerr.New(narsilerr.CodePersistenceCrcMismatch,
				"Page "+strconv.FormatInt(page, 10)+" of section \""+section.Name+"\" does not match its checksum",
				map[string]any{"section": section.Name, "page": page})
		}
	}
	return span[position-spanStart : position-spanStart+length], nil
}

func (reader *Reader) WholeSection(name string) ([]byte, error) {
	section, err := reader.Section(name)
	if err != nil {
		return nil, err
	}
	return reader.ReadSection(section, 0, section.Length)
}

func (reader *Reader) uint32At(section Section, index int64) (uint32, error) {
	bytes, err := reader.ReadSection(section, index*4, 4)
	if err != nil {
		return 0, err
	}
	return binary.LittleEndian.Uint32(bytes), nil
}
