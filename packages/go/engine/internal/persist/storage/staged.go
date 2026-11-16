package storage

import (
	"bufio"
	"io"
	"os"
	"path/filepath"
	"sync"

	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type StagedFile struct {
	mu        sync.Mutex
	directory *Directory
	key       string
	path      string
	temporary string
	file      *os.File
	closed    bool
	removed   bool
}

func (directory *Directory) Stage(key string) (*StagedFile, error) {
	path, err := directory.PathOf(key)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), directoryMode); err != nil {
		return nil, saveFailed(`Failed to create the directory for "`+key+`"`, key, err)
	}
	temporary := path + temporarySuffix()
	file, err := openFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, fileMode)
	if err != nil {
		return nil, saveFailed(`Failed to create "`+key+`"`, key, err)
	}
	return &StagedFile{directory: directory, key: key, path: path, temporary: temporary, file: file}, nil
}

func (staged *StagedFile) Fill(write func(io.Writer) error) error {
	buffered := bufio.NewWriterSize(staged.file, streamWriteBufferBytes)
	wrap := func(cause error) error {
		return saveFailed(`Write to "`+staged.key+`" failed; the write is not acknowledged`, staged.key, cause)
	}
	if err := write(buffered); err != nil {
		return keepNarsilError(err, wrap)
	}
	if err := buffered.Flush(); err != nil {
		return wrap(err)
	}
	return nil
}

func (staged *StagedFile) Commit() error {
	staged.mu.Lock()
	defer staged.mu.Unlock()
	if staged.closed {
		return narsilerr.New(narsilerr.CodePersistenceSaveFailed,
			`The write of "`+staged.key+`" was abandoned before it finished`, map[string]any{"key": staged.key})
	}
	staged.closed = true
	if err := staged.file.Sync(); err != nil {
		_ = staged.file.Close()
		staged.removeTemporary()
		return fsyncFailed(staged.temporary, err)
	}
	if err := staged.file.Close(); err != nil {
		staged.removeTemporary()
		return saveFailed(`Failed to close "`+staged.key+`"`, staged.key, err)
	}
	if err := os.Rename(staged.temporary, staged.path); err != nil {
		staged.removeTemporary()
		return saveFailed(`Failed to rename "`+staged.key+`" into place`, staged.key, err)
	}
	staged.removed = true
	synced := syncDirectory(filepath.Dir(staged.path))
	measurePath(staged.directory.sizesOf(staged.key), staged.key, staged.path)
	return synced
}

func (staged *StagedFile) Abort() {
	staged.mu.Lock()
	defer staged.mu.Unlock()
	if !staged.closed {
		staged.closed = true
		_ = staged.file.Close()
	}
	staged.removeTemporary()
}

func (staged *StagedFile) removeTemporary() {
	if staged.removed {
		return
	}
	if err := os.Remove(staged.temporary); err == nil || isMissing(err) {
		staged.removed = true
	}
}
