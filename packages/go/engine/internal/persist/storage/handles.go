package storage

import (
	"errors"
	"io"
	"os"
	"path/filepath"

	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type AppendFile struct {
	key   string
	file  *os.File
	sizes FileSizes
}

func (directory *Directory) OpenAppend(key string) (*AppendFile, error) {
	path, err := directory.PathOf(key)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), directoryMode); err != nil {
		return nil, saveFailed(`Failed to create the directory for "`+key+`"`, key, err)
	}
	file, err := openFile(path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, fileMode)
	if err != nil {
		return nil, saveFailed(`Failed to open "`+key+`" for appending`, key, err)
	}
	opened := &AppendFile{key: key, file: file, sizes: directory.sizesOf(key)}
	measureFile(opened.sizes, key, file)
	return opened, nil
}

func (handle *AppendFile) Key() string {
	return handle.key
}

func (handle *AppendFile) Append(bytes []byte) error {
	if _, err := handle.file.Write(bytes); err != nil {
		measureFile(handle.sizes, handle.key, handle.file)
		return saveFailed(`Write to "`+handle.key+`" failed; the write is not acknowledged`, handle.key, err)
	}
	if handle.sizes != nil {
		handle.sizes.Grew(handle.key, int64(len(bytes)))
	}
	return nil
}

func (handle *AppendFile) Sync() error {
	if err := handle.file.Sync(); err != nil {
		return fsyncFailed(handle.key, err)
	}
	return nil
}

func (handle *AppendFile) Truncate(length int64) error {
	err := handle.file.Truncate(length)
	measureFile(handle.sizes, handle.key, handle.file)
	if err != nil {
		return saveFailed(`Failed to truncate "`+handle.key+`"`, handle.key, err)
	}
	if _, err := handle.file.Seek(length, io.SeekStart); err != nil {
		return saveFailed(`Failed to move to the end of "`+handle.key+`"`, handle.key, err)
	}
	return handle.Sync()
}

func (handle *AppendFile) Size() (int64, error) {
	info, err := handle.file.Stat()
	if err != nil {
		return 0, loadFailed(`Failed to read the length of "`+handle.key+`"`, handle.key, err)
	}
	return info.Size(), nil
}

func (handle *AppendFile) Close() error {
	if handle.file == nil {
		return nil
	}
	err := handle.file.Close()
	handle.file = nil
	if err != nil && !errors.Is(err, os.ErrClosed) {
		return saveFailed(`Failed to close "`+handle.key+`"`, handle.key, err)
	}
	return nil
}

type MarkerFile struct {
	key     string
	file    *os.File
	created bool
}

func (directory *Directory) OpenMarker(key string) (*MarkerFile, error) {
	path, err := directory.PathOf(key)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), directoryMode); err != nil {
		return nil, saveFailed(`Failed to create the directory for "`+key+`"`, key, err)
	}
	created := false
	file, err := openFile(path, os.O_RDWR, fileMode)
	if isMissing(err) {
		file, err = openFile(path, os.O_RDWR|os.O_CREATE|os.O_EXCL, fileMode)
		created = err == nil
		if errors.Is(err, os.ErrExist) {
			file, err = openFile(path, os.O_RDWR, fileMode)
		}
	}
	if err != nil {
		return nil, saveFailed(`Failed to open the commit marker "`+key+`"`, key, err)
	}
	return &MarkerFile{key: key, file: file, created: created}, nil
}

func (handle *MarkerFile) Created() bool {
	return handle.created
}

func (handle *MarkerFile) Read(maximum int64) ([]byte, error) {
	info, err := handle.file.Stat()
	if err != nil {
		return nil, loadFailed(`Failed to read "`+handle.key+`"`, handle.key, err)
	}
	length := min(info.Size(), maximum)
	data := make([]byte, length)
	if _, err := handle.file.ReadAt(data, 0); err != nil && !errors.Is(err, io.EOF) {
		return nil, loadFailed(`Failed to read "`+handle.key+`"`, handle.key, err)
	}
	return data, nil
}

func (handle *MarkerFile) WriteSlot(offset int64, slot []byte) error {
	if _, err := handle.file.WriteAt(slot, offset); err != nil {
		return saveFailed(`Write to "`+handle.key+`" failed; the write is not acknowledged`, handle.key, err)
	}
	if err := handle.file.Sync(); err != nil {
		return fsyncFailed(handle.key, err)
	}
	return nil
}

func (handle *MarkerFile) Close() error {
	if handle.file == nil {
		return nil
	}
	err := handle.file.Close()
	handle.file = nil
	if err != nil {
		return narsilerr.Wrap(narsilerr.CodePersistenceSaveFailed, `Failed to close "`+handle.key+`"`, err, nil)
	}
	return nil
}
