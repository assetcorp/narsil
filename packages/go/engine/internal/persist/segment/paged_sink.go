package segment

import (
	"bufio"
	"encoding/binary"
	"io"
	"os"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/paged"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

const (
	scratchFileMode     = 0o644
	scratchSectionInfix = ".part-"
)

func scratchFailed(message string, path string, cause error) error {
	return narsilerr.Wrap(narsilerr.CodePersistenceSaveFailed, message, cause, map[string]any{"path": path})
}

type scratchFile struct {
	path     string
	file     *os.File
	buffered *bufio.Writer
	length   int64
	closed   bool
}

func openScratch(path string, bufferBytes int) (*scratchFile, error) {
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return nil, scratchFailed(`The scratch file "`+path+`" cannot be cleared`, path, err)
	}
	file, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|os.O_TRUNC, scratchFileMode)
	if err != nil {
		return nil, scratchFailed(`The scratch file "`+path+`" cannot be created`, path, err)
	}
	return &scratchFile{path: path, file: file, buffered: bufio.NewWriterSize(file, bufferBytes)}, nil
}

func (scratch *scratchFile) write(data []byte) error {
	if _, err := scratch.buffered.Write(data); err != nil {
		return scratchFailed(`The scratch file "`+scratch.path+`" cannot be written`, scratch.path, err)
	}
	scratch.length += int64(len(data))
	return nil
}

func (scratch *scratchFile) flush() error {
	if err := scratch.buffered.Flush(); err != nil {
		return scratchFailed(`The scratch file "`+scratch.path+`" cannot be written`, scratch.path, err)
	}
	return nil
}

func (scratch *scratchFile) readAll() ([]byte, error) {
	if err := scratch.flush(); err != nil {
		return nil, err
	}
	data := make([]byte, scratch.length)
	if read, err := scratch.file.ReadAt(data, 0); int64(read) != scratch.length {
		if err == nil {
			err = io.ErrUnexpectedEOF
		}
		return nil, scratchFailed(`The scratch file "`+scratch.path+`" cannot be read back`, scratch.path, err)
	}
	return data, nil
}

func (scratch *scratchFile) discard() {
	if scratch.closed {
		return
	}
	scratch.closed = true
	_ = scratch.file.Close()
	_ = os.Remove(scratch.path)
}

type sectionSink struct {
	name      string
	scratch   *scratchFile
	state     uint32
	filled    int64
	checksums []byte
}

func openSectionSink(scratchPath string, name string) (*sectionSink, error) {
	scratch, err := openScratch(scratchPath+scratchSectionInfix+name, sectionWriteBufferBytes)
	if err != nil {
		return nil, err
	}
	return &sectionSink{name: name, scratch: scratch}, nil
}

func (sink *sectionSink) closePage() {
	sink.checksums = binary.LittleEndian.AppendUint32(sink.checksums, codec.CRC32Final(sink.state))
	sink.filled = 0
}

func (sink *sectionSink) write(data []byte) error {
	for rest := data; len(rest) > 0; {
		if sink.filled == 0 {
			sink.state = codec.CRC32Init()
		}
		take := min(int64(len(rest)), paged.SegmentPageBytes-sink.filled)
		sink.state = codec.CRC32Update(sink.state, rest[:take])
		sink.filled += take
		rest = rest[take:]
		if sink.filled == paged.SegmentPageBytes {
			sink.closePage()
		}
	}
	return sink.scratch.write(data)
}

func (sink *sectionSink) source() (paged.SectionSource, error) {
	if err := sink.scratch.flush(); err != nil {
		return paged.SectionSource{}, err
	}
	if sink.filled > 0 {
		sink.closePage()
	}
	scratch, length := sink.scratch, sink.scratch.length
	return paged.SectionSource{Name: sink.name, Length: length, Checksums: sink.checksums,
		WriteTo: func(writer io.Writer) error {
			buffer := make([]byte, max(min(length, fileAssemblyChunkBytes), 1))
			copied, err := io.CopyBuffer(writer, io.NewSectionReader(scratch.file, 0, length), buffer)
			if err != nil {
				return err
			}
			if copied != length {
				return scratchFailed(`The scratch file "`+scratch.path+`" holds fewer bytes than were written`,
					scratch.path, io.ErrUnexpectedEOF)
			}
			return nil
		}}, nil
}
