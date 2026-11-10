package paged

import (
	"errors"
	"io"
	"os"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/vector"
)

type PageSource interface {
	ReadPage(section Section, page int64, target []byte) error
}

type NativeFile struct {
	file   *os.File
	native *core.PagedFile
	path   string
	size   int64
}

func cannotOpen(path string, cause error) error {
	return narsilerr.Wrap(narsilerr.CodePersistenceLoadFailed, `The core cannot open "`+path+`" for reading`, cause,
		map[string]any{"path": path})
}

func OpenNativeFile(file *os.File, path string) (*NativeFile, error) {
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, cannotOpen(path, err)
	}
	native, err := core.OpenPagedFile(path)
	if err != nil {
		_ = file.Close()
		return nil, cannotOpen(path, err)
	}
	return &NativeFile{file: file, native: native, path: path, size: info.Size()}, nil
}

func (file *NativeFile) ReadAt(target []byte, offset int64) (int, error) {
	return file.file.ReadAt(target, offset)
}

func (file *NativeFile) Size() int64 {
	return file.size
}

func (file *NativeFile) PageSection(section Section) core.PageSection {
	return core.PageSection{
		File:      file.native,
		Offset:    uint64(envelope.HeaderBytes + section.Offset),
		Length:    uint64(section.Length),
		PageBytes: uint32(section.PageBytes),
		Checksums: section.Checksums,
	}
}

func (file *NativeFile) ReadPage(section Section, page int64, target []byte) error {
	workspace, err := core.AcquireWorkspace()
	if err != nil {
		return err
	}
	defer workspace.Release()
	err = workspace.ReadPage(nil, file.PageSection(section), uint64(page), target)
	var fault *core.PageError
	if errors.As(err, &fault) {
		return vector.PageFailure(fault, file.path, section.Name)
	}
	return err
}

func (file *NativeFile) Close() error {
	file.native.Close()
	return file.file.Close()
}

func readPageOf(source io.ReaderAt, section Section, page int64, target []byte, key string) error {
	if native, held := source.(PageSource); held {
		return native.ReadPage(section, page, target)
	}
	offset := envelope.HeaderBytes + section.Offset + page*section.PageBytes
	if err := readFileRange(source, offset, target, key); err != nil {
		return err
	}
	return requirePage(section, page, target, key)
}
