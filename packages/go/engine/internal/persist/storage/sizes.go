package storage

import "os"

type FileSizes interface {
	Tracks(key string) bool
	Sized(key string, bytes int64)
	Grew(key string, bytes int64)
	Removed(key string)
}

func (directory *Directory) TrackSizes(sizes FileSizes) {
	directory.sizes = sizes
}

func (directory *Directory) sizesOf(key string) FileSizes {
	if directory.sizes == nil || !directory.sizes.Tracks(key) {
		return nil
	}
	return directory.sizes
}

func (directory *Directory) forgetSize(key string) {
	if sizes := directory.sizesOf(key); sizes != nil {
		sizes.Removed(key)
	}
}

func measurePath(sizes FileSizes, key string, path string) {
	if sizes == nil {
		return
	}
	info, err := os.Stat(path)
	switch {
	case err == nil:
		sizes.Sized(key, info.Size())
	case isMissing(err):
		sizes.Removed(key)
	}
}

func measureFile(sizes FileSizes, key string, file *os.File) {
	if sizes == nil || file == nil {
		return
	}
	if info, err := file.Stat(); err == nil {
		sizes.Sized(key, info.Size())
	}
}
