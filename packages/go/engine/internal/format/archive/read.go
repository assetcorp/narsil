package archive

import (
	"bufio"
	"errors"
	"io"
	"strconv"
	"strings"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/form"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

const (
	ConfigEntry        = "config"
	ManifestEntry      = "manifest"
	HistoryEntryPrefix = "query-history/"
)

type ListedFile struct {
	Name     string
	Bytes    int64
	Checksum uint32
}

type Handlers struct {
	Config   func(data []byte) error
	Manifest func(data []byte) ([]ListedFile, error)
	File     func(file ListedFile, body io.Reader) error
	History  func(position int, body io.Reader) error
}

type entryHeader struct {
	name string
	size int64
}

type reader struct {
	source *bufio.Reader
}

func readFailed(err error) error {
	if _, isNarsil := narsilerr.As(err); isNarsil {
		return err
	}
	return narsilerr.Wrap(narsilerr.CodePersistenceLoadFailed, "Invalid snapshot archive: the archive fails to read", err, nil)
}

func (state *reader) readBlock() ([]byte, error) {
	block := make([]byte, BlockBytes)
	read, err := io.ReadFull(state.source, block)
	switch {
	case err == nil:
		return block, nil
	case errors.Is(err, io.EOF) && read == 0:
		return nil, nil
	case errors.Is(err, io.ErrUnexpectedEOF):
		return nil, invalidArchive("the archive ends inside an entry header", nil)
	default:
		return nil, readFailed(err)
	}
}

func (state *reader) skip(length int64, where string) error {
	if length == 0 {
		return nil
	}
	skipped, err := io.CopyN(io.Discard, state.source, length)
	if skipped == length {
		return nil
	}
	if err == nil || errors.Is(err, io.EOF) {
		return invalidArchive("the archive ends inside "+where, nil)
	}
	return readFailed(err)
}

func (state *reader) readPadded(size int64) ([]byte, error) {
	body := make([]byte, 0, min(size, FileChunkBytes))
	for int64(len(body)) < size {
		if len(body) == cap(body) {
			grown := make([]byte, len(body), min(size, int64(cap(body))*2))
			copy(grown, body)
			body = grown
		}
		read, err := state.source.Read(body[len(body):cap(body)])
		body = body[:len(body)+read]
		if err == nil || int64(len(body)) == size {
			continue
		}
		if errors.Is(err, io.EOF) {
			return nil, invalidArchive("the archive ends inside an entry", nil)
		}
		return nil, readFailed(err)
	}
	if err := state.skip(Padding(size), "the padding of an entry"); err != nil {
		return nil, err
	}
	return body, nil
}

func (state *reader) nextEntry() (*entryHeader, error) {
	block, err := state.readBlock()
	if err != nil || block == nil || isZeroBlock(block) {
		return nil, err
	}
	header, err := parseHeader(block)
	if err != nil {
		return nil, err
	}
	if !header.isPax {
		return &entryHeader{name: header.name, size: header.size}, nil
	}
	if header.size > MaxPaxHeaderBytes {
		return nil, invalidArchive("a pax extended header is too long", map[string]any{"bytes": header.size})
	}
	body, err := state.readPadded(header.size)
	if err != nil {
		return nil, err
	}
	records, err := parsePaxRecords(body)
	if err != nil {
		return nil, err
	}
	next, err := state.readBlock()
	if err != nil {
		return nil, err
	}
	if next == nil || isZeroBlock(next) {
		return nil, invalidArchive("a pax extended header precedes no entry", nil)
	}
	entry, err := parseHeader(next)
	if err != nil {
		return nil, err
	}
	if entry.isPax {
		return nil, invalidArchive("a pax extended header follows another", nil)
	}
	resolved := entryHeader{name: entry.name, size: entry.size}
	if path, ok := records["path"]; ok {
		resolved.name = path
	}
	if text, ok := records["size"]; ok {
		size, parseErr := strconv.ParseInt(text, 10, 64)
		if parseErr != nil || size < 0 || size > form.MaxSafeInteger || strings.TrimLeft(text, "0123456789") != "" {
			return nil, invalidArchive("a pax extended header holds an invalid size", nil)
		}
		resolved.size = size
	}
	return &resolved, nil
}

func (state *reader) readNamed(expected string) ([]byte, error) {
	header, err := state.nextEntry()
	if err != nil {
		return nil, err
	}
	if header == nil {
		return nil, invalidArchive("the archive ends before its "+expected+" entry", nil)
	}
	if header.name != expected {
		return nil, invalidArchive("the archive holds \""+header.name+"\" where its "+expected+" entry belongs",
			map[string]any{"entry": header.name})
	}
	if header.size > envelope.MaxFileBytes {
		return nil, invalidArchive("the "+expected+" entry passes the file size limit", map[string]any{"bytes": header.size})
	}
	return state.readPadded(header.size)
}

func Read(source io.Reader, handlers Handlers) error {
	state := &reader{source: bufio.NewReaderSize(source, ReadBufferBytes)}
	config, err := state.readNamed(ConfigEntry)
	if err != nil {
		return err
	}
	if handlers.Config != nil {
		if err := handlers.Config(config); err != nil {
			return err
		}
	}
	manifest, err := state.readNamed(ManifestEntry)
	if err != nil {
		return err
	}
	if handlers.Manifest == nil {
		return invalidArchive("the reader has no way to read the manifest", nil)
	}
	files, err := handlers.Manifest(manifest)
	if err != nil {
		return err
	}
	if err := state.readFiles(files, handlers.File); err != nil {
		return err
	}
	return state.readHistory(handlers.History)
}

func whyOutOfPlace(name string, listed map[string]struct{}, seen map[string]struct{}) string {
	if _, isListed := listed[name]; !isListed {
		return "that the manifest does not list"
	}
	if _, isSeen := seen[name]; isSeen {
		return "twice"
	}
	return "out of order"
}

func (state *reader) readFiles(files []ListedFile, handle func(ListedFile, io.Reader) error) error {
	listed := make(map[string]struct{}, len(files))
	for _, file := range files {
		listed[file.Name] = struct{}{}
	}
	seen := make(map[string]struct{}, len(files))
	for _, file := range files {
		header, err := state.nextEntry()
		if err != nil {
			return err
		}
		if header == nil {
			return invalidArchive("the archive ends before it holds \""+file.Name+"\"", map[string]any{"entry": file.Name})
		}
		if header.name != file.Name {
			return invalidArchive("the archive holds the entry \""+header.name+"\" "+whyOutOfPlace(header.name, listed, seen),
				map[string]any{"entry": header.name})
		}
		if header.size != file.Bytes {
			return invalidArchive("the entry \""+file.Name+"\" holds "+strconv.FormatInt(header.size, 10)+
				" bytes where the manifest lists "+strconv.FormatInt(file.Bytes, 10), map[string]any{"entry": file.Name})
		}
		if err := state.requireEnvelopeChecksum(file); err != nil {
			return err
		}
		seen[file.Name] = struct{}{}
		if err := state.deliver(header.size, func(body io.Reader) error {
			if handle == nil {
				return nil
			}
			return handle(file, body)
		}); err != nil {
			return err
		}
	}
	return nil
}

func (state *reader) requireEnvelopeChecksum(file ListedFile) error {
	mismatch := invalidArchive("the entry \""+file.Name+"\" carries a checksum other than the manifest lists",
		map[string]any{"entry": file.Name})
	if file.Bytes < envelope.HeaderBytes {
		return mismatch
	}
	start, err := state.source.Peek(envelope.HeaderBytes)
	if len(start) < envelope.HeaderBytes {
		if err != nil && !errors.Is(err, io.EOF) {
			return readFailed(err)
		}
		return mismatch
	}
	if checksum, ok := envelope.ChecksumBytesOf(start); !ok || checksum != file.Checksum {
		return mismatch
	}
	return nil
}

func (state *reader) deliver(size int64, handle func(io.Reader) error) error {
	body := &entryBody{source: state.source, remaining: size}
	if err := handle(body); err != nil {
		return err
	}
	if body.failure != nil {
		return body.failure
	}
	if err := state.skip(body.remaining, "an entry"); err != nil {
		return err
	}
	return state.skip(Padding(size), "the padding of an entry")
}

func (state *reader) readHistory(handle func(int, io.Reader) error) error {
	for position := 0; ; position++ {
		header, err := state.nextEntry()
		if err != nil || header == nil {
			return err
		}
		expected := HistoryEntryPrefix + strconv.Itoa(position)
		if header.name != expected {
			return invalidArchive("the archive holds the entry \""+header.name+"\" that the manifest does not list",
				map[string]any{"entry": header.name})
		}
		if header.size > MaxHistoryFileBytes {
			return invalidArchive("the entry \""+header.name+"\" passes the history file limit of "+
				strconv.Itoa(MaxHistoryFileBytes)+" bytes", map[string]any{"entry": header.name})
		}
		if err := state.deliver(header.size, func(body io.Reader) error {
			if handle == nil {
				return nil
			}
			return handle(position, body)
		}); err != nil {
			return err
		}
	}
}

type entryBody struct {
	source    io.Reader
	remaining int64
	failure   error
}

func (body *entryBody) Read(destination []byte) (int, error) {
	if body.failure != nil {
		return 0, body.failure
	}
	if body.remaining == 0 {
		return 0, io.EOF
	}
	if int64(len(destination)) > body.remaining {
		destination = destination[:body.remaining]
	}
	read, err := body.source.Read(destination)
	body.remaining -= int64(read)
	if err == nil || body.remaining == 0 {
		return read, nil
	}
	if errors.Is(err, io.EOF) {
		body.failure = invalidArchive("the archive ends inside an entry", nil)
	} else {
		body.failure = readFailed(err)
	}
	return read, body.failure
}
