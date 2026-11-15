package storage

import (
	"io"
	"os"
	"path/filepath"
)

func (directory *Directory) Link(from string, to string) error {
	source, err := directory.PathOf(from)
	if err != nil {
		return err
	}
	target, err := directory.PathOf(to)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(target), directoryMode); err != nil {
		return saveFailed(`Failed to create the directory for "`+to+`"`, to, err)
	}
	linkErr := os.Link(source, target)
	if linkErr == nil {
		return nil
	}
	if isMissing(linkErr) {
		return loadFailed(`Failed to read "`+from+`"`, from, linkErr)
	}
	return copyInto(source, target, from, to)
}

func copyInto(source string, target string, from string, to string) error {
	reading, err := OpenForReading(source)
	if err != nil {
		return loadFailed(`Failed to read "`+from+`"`, from, err)
	}
	defer reading.Close()
	writing, err := openFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, fileMode)
	if err != nil {
		return saveFailed(`Failed to create "`+to+`"`, to, err)
	}
	if _, err := io.Copy(writing, reading); err != nil {
		_ = writing.Close()
		return saveFailed(`Failed to copy "`+from+`" to "`+to+`"`, to, err)
	}
	if err := writing.Close(); err != nil {
		return saveFailed(`Failed to close "`+to+`"`, to, err)
	}
	return nil
}
