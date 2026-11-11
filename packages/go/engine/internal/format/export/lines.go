package export

import (
	"bufio"
	"errors"
	"io"

	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type Line struct {
	Number  int
	Text    []byte
	TooLong bool
}

type LineReader struct {
	source   *bufio.Reader
	maxBytes int
	number   int
	pending  []byte
	ended    bool
}

func NewLineReader(source io.Reader, maxBytes int) *LineReader {
	return &LineReader{source: bufio.NewReaderSize(source, ReadBufferBytes), maxBytes: maxBytes}
}

func (reader *LineReader) Next() (Line, bool, error) {
	if reader.ended {
		return Line{}, false, nil
	}
	reader.pending = reader.pending[:0]
	overflowing := false
	read := 0
	for {
		piece, err := reader.source.ReadSlice('\n')
		read += len(piece)
		complete := err == nil
		if complete {
			piece = piece[:len(piece)-1]
		}
		if !overflowing && len(reader.pending)+len(piece) <= reader.maxBytes {
			reader.pending = append(reader.pending, piece...)
		} else {
			overflowing = true
			reader.pending = reader.pending[:0]
		}
		if complete {
			return reader.finish(overflowing), true, nil
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		reader.ended = true
		if !errors.Is(err, io.EOF) {
			return Line{}, false, narsilerr.Wrap(narsilerr.CodePersistenceLoadFailed,
				"The document export fails to read", err, nil)
		}
		if read == 0 {
			return Line{}, false, nil
		}
		return reader.finish(overflowing), true, nil
	}
}

func (reader *LineReader) finish(overflowing bool) Line {
	reader.number++
	if overflowing {
		return Line{Number: reader.number, TooLong: true}
	}
	return Line{Number: reader.number, Text: reader.pending}
}
