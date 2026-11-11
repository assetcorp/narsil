package storage

import (
	"errors"
	"io"
	"io/fs"
	"os"
	"syscall"

	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

func saveFailed(message string, key string, cause error) error {
	return narsilerr.Wrap(narsilerr.CodePersistenceSaveFailed, message, cause, map[string]any{"key": key})
}

func loadFailed(message string, key string, cause error) error {
	return narsilerr.Wrap(narsilerr.CodePersistenceLoadFailed, message, cause, map[string]any{"key": key})
}

func fsyncFailed(path string, cause error) error {
	return narsilerr.Wrap(narsilerr.CodePersistenceFsyncFailed,
		`fsync failed for "`+path+`"; the write is not acknowledged and the node must recover from the durable log`,
		cause, map[string]any{"key": path})
}

func deleteFailed(key string, cause error) error {
	return narsilerr.Wrap(narsilerr.CodePersistenceDeleteFailed, `Failed to delete "`+key+`"`, cause,
		map[string]any{"key": key})
}

func isMissing(err error) bool {
	return errors.Is(err, fs.ErrNotExist)
}

func directorySyncUnsupported(err error) bool {
	return errors.Is(err, syscall.EISDIR) || errors.Is(err, syscall.EPERM) || errors.Is(err, syscall.EINVAL) ||
		errors.Is(err, syscall.ENOTSUP) || errors.Is(err, syscall.EBADF) || directorySyncUnsupportedHere(err)
}

func readWhole(path string) ([]byte, error) {
	file, err := openFile(path, os.O_RDONLY, 0)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	return io.ReadAll(file)
}

func keepNarsilError(err error, wrap func(error) error) error {
	if _, typed := narsilerr.As(err); typed {
		return err
	}
	return wrap(err)
}
