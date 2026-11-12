package paged

import (
	"errors"
	"io"
	"os"
	"sync"
	"weak"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/vector"
)

type PageSource interface {
	ReadPage(section Section, page int64, target []byte) error
}

type NativeFile struct {
	mu     sync.RWMutex
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
	opened := &NativeFile{file: file, native: native, path: path, size: info.Size()}
	openFiles.add(opened)
	return opened, nil
}

func (file *NativeFile) ReadAt(target []byte, offset int64) (int, error) {
	file.mu.RLock()
	defer file.mu.RUnlock()
	if file.file == nil {
		return 0, os.ErrClosed
	}
	return file.file.ReadAt(target, offset)
}

func (file *NativeFile) Suspend() error {
	file.mu.Lock()
	defer file.mu.Unlock()
	if file.file == nil {
		return os.ErrClosed
	}
	if err := file.native.Suspend(); err != nil {
		return err
	}
	err := file.file.Close()
	file.file = nil
	return err
}

func (file *NativeFile) Resume(opened *os.File, path string) error {
	file.mu.Lock()
	defer file.mu.Unlock()
	info, err := opened.Stat()
	if err == nil && info.Size() != file.size {
		err = core.ErrPagedFileChanged
	}
	if err == nil && file.file != nil {
		err = os.ErrExist
	}
	if err == nil {
		err = file.native.Resume(path)
	}
	if err != nil {
		_ = opened.Close()
		return cannotOpen(path, err)
	}
	file.file, file.path = opened, path
	return nil
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
		file.mu.RLock()
		path := file.path
		file.mu.RUnlock()
		return vector.PageFailure(fault, path, section.Name)
	}
	return err
}

func (file *NativeFile) Close() error {
	openFiles.remove(weak.Make(file))
	file.mu.Lock()
	defer file.mu.Unlock()
	file.native.Close()
	if file.file == nil {
		return nil
	}
	err := file.file.Close()
	file.file = nil
	return err
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
