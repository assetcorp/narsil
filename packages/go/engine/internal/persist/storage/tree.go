package storage

import (
	"os"
	"path/filepath"
	"strings"
)

func (directory *Directory) MoveTree(from string, to string) error {
	source, err := directory.PathOf(from)
	if err != nil {
		return err
	}
	target, err := directory.PathOf(to)
	if err != nil {
		return err
	}
	if err := os.Rename(source, target); err != nil {
		if isMissing(err) {
			return nil
		}
		return saveFailed(`Failed to move "`+from+`" to "`+to+`"`, to, err)
	}
	if err := syncDirectory(filepath.Dir(target)); err != nil {
		return err
	}
	if filepath.Dir(source) != filepath.Dir(target) {
		return syncDirectory(filepath.Dir(source))
	}
	return nil
}

func (directory *Directory) RemoveTree(prefix string) error {
	key := strings.TrimSuffix(prefix, "/")
	path, err := directory.PathOf(key)
	if err != nil {
		return err
	}
	if path == directory.root {
		return deleteFailed(key, os.ErrInvalid)
	}
	if err := os.RemoveAll(path); err != nil {
		return deleteFailed(key, err)
	}
	return syncDirectory(filepath.Dir(path))
}
