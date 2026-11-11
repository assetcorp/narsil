package storage

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type Directory struct {
	root  string
	sizes FileSizes
}

func OpenDirectory(root string) (*Directory, error) {
	if strings.TrimSpace(root) == "" {
		return nil, narsilerr.New(narsilerr.CodeConfigInvalid, "Durable directory requires a non-empty root path", nil)
	}
	resolved, err := filepath.Abs(root)
	if err != nil {
		return nil, narsilerr.Wrap(narsilerr.CodeConfigInvalid, `The durable directory "`+root+`" cannot be resolved`,
			err, nil)
	}
	if err := os.MkdirAll(resolved, directoryMode); err != nil {
		return nil, saveFailed(`The durable directory "`+root+`" cannot be created`, root, err)
	}
	return &Directory{root: resolved}, nil
}

func (directory *Directory) Root() string {
	return directory.root
}

func (directory *Directory) PathOf(key string) (string, error) {
	if key == "" {
		return "", narsilerr.New(narsilerr.CodePersistenceSaveFailed, "Invalid key: empty", nil)
	}
	if strings.ContainsRune(key, 0) {
		return "", narsilerr.New(narsilerr.CodePersistenceSaveFailed, "Invalid key: null byte detected",
			map[string]any{"key": key})
	}
	resolved := filepath.Join(directory.root, filepath.FromSlash(key))
	if resolved != directory.root && !strings.HasPrefix(resolved, directory.root+string(filepath.Separator)) {
		return "", narsilerr.New(narsilerr.CodePersistenceSaveFailed, "Invalid key: path traversal detected",
			map[string]any{"key": key})
	}
	return resolved, nil
}

func (directory *Directory) Identity() (string, bool, error) {
	identity, err := identityAt(directory.root)
	if err != nil {
		if isMissing(err) {
			return "", false, nil
		}
		return "", false, loadFailed(`The durable directory "`+directory.root+`" cannot be read`, directory.root, err)
	}
	return identity, true, nil
}

func OpenForReading(path string) (*os.File, error) {
	return openFile(path, os.O_RDONLY, 0)
}

func (directory *Directory) Read(key string) ([]byte, error) {
	return directory.ReadAtMost(key, envelope.MaxFileBytes)
}

func (directory *Directory) ReadAtMost(key string, maximum int64) ([]byte, error) {
	path, err := directory.PathOf(key)
	if err != nil {
		return nil, err
	}
	file, err := OpenForReading(path)
	if err != nil {
		if isMissing(err) {
			return nil, nil
		}
		return nil, loadFailed(`Failed to read "`+key+`"`, key, err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, loadFailed(`Failed to read "`+key+`"`, key, err)
	}
	if info.IsDir() {
		return nil, nil
	}
	if info.Size() > maximum {
		return nil, narsilerr.New(narsilerr.CodePersistenceLoadFailed,
			`"`+key+`" holds `+strconv.FormatInt(info.Size(), 10)+" bytes, above the "+
				strconv.FormatInt(maximum, 10)+" bytes that a reader accepts",
			map[string]any{"key": key, "bytes": info.Size(), "maximum": maximum})
	}
	data := make([]byte, info.Size())
	if _, err := io.ReadFull(file, data); err != nil {
		return nil, loadFailed(`"`+key+`" changed length while it was read`, key, err)
	}
	return data, nil
}

func (directory *Directory) ReadPrefix(key string, length int) ([]byte, error) {
	path, err := directory.PathOf(key)
	if err != nil {
		return nil, err
	}
	file, err := OpenForReading(path)
	if err != nil {
		if isMissing(err) {
			return nil, nil
		}
		return nil, loadFailed(`Failed to read "`+key+`"`, key, err)
	}
	defer file.Close()
	data := make([]byte, length)
	read, err := io.ReadFull(file, data)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return nil, loadFailed(`Failed to read "`+key+`"`, key, err)
	}
	return data[:read], nil
}

func (directory *Directory) Size(key string) (int64, bool, error) {
	path, err := directory.PathOf(key)
	if err != nil {
		return 0, false, err
	}
	info, err := os.Stat(path)
	if err != nil {
		if isMissing(err) {
			return 0, false, nil
		}
		return 0, false, loadFailed(`Failed to read the length of "`+key+`"`, key, err)
	}
	return info.Size(), !info.IsDir(), nil
}

func syncDirectory(path string) error {
	handle, err := OpenForReading(path)
	if err != nil {
		if directorySyncUnsupported(err) {
			return nil
		}
		return fsyncFailed(path, err)
	}
	defer handle.Close()
	if err := handle.Sync(); err != nil && !directorySyncUnsupported(err) {
		return fsyncFailed(path, err)
	}
	return nil
}

func (directory *Directory) SyncDirectoryOf(key string) error {
	path, err := directory.PathOf(key)
	if err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(path))
}

func temporarySuffix() string {
	random := make([]byte, temporaryNameRandomBytes)
	_, _ = rand.Read(random)
	return ".tmp-" + strconv.Itoa(os.Getpid()) + "-" + hex.EncodeToString(random)
}

func writeAll(file *os.File, chunks [][]byte, key string) error {
	for _, chunk := range chunks {
		if _, err := file.Write(chunk); err != nil {
			return saveFailed(`Write to "`+key+`" failed; the write is not acknowledged`, key, err)
		}
	}
	return nil
}

func (directory *Directory) AtomicWrite(key string, chunks ...[]byte) error {
	return directory.atomicReplace(key, func(file *os.File) error {
		return writeAll(file, chunks, key)
	})
}

func (directory *Directory) AtomicWriteStream(key string, write func(io.Writer) error) error {
	return directory.atomicReplace(key, func(file *os.File) error {
		buffered := bufio.NewWriterSize(file, streamWriteBufferBytes)
		wrap := func(cause error) error {
			return saveFailed(`Write to "`+key+`" failed; the write is not acknowledged`, key, cause)
		}
		if err := write(buffered); err != nil {
			return keepNarsilError(err, wrap)
		}
		if err := buffered.Flush(); err != nil {
			return wrap(err)
		}
		return nil
	})
}

func (directory *Directory) atomicReplace(key string, fill func(*os.File) error) error {
	path, err := directory.PathOf(key)
	if err != nil {
		return err
	}
	parent := filepath.Dir(path)
	if err := os.MkdirAll(parent, directoryMode); err != nil {
		return saveFailed(`Failed to create the directory for "`+key+`"`, key, err)
	}
	temporary := path + temporarySuffix()
	file, err := openFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, fileMode)
	if err != nil {
		return saveFailed(`Failed to create "`+key+`"`, key, err)
	}
	fail := func(cause error) error {
		_ = file.Close()
		_ = os.Remove(temporary)
		return cause
	}
	if err := fill(file); err != nil {
		return fail(err)
	}
	if err := file.Sync(); err != nil {
		return fail(fsyncFailed(temporary, err))
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(temporary)
		return saveFailed(`Failed to close "`+key+`"`, key, err)
	}
	if err := os.Rename(temporary, path); err != nil {
		_ = os.Remove(temporary)
		return saveFailed(`Failed to rename "`+key+`" into place`, key, err)
	}
	synced := syncDirectory(parent)
	measurePath(directory.sizesOf(key), key, path)
	return synced
}

func (directory *Directory) Remove(key string) error {
	path, err := directory.PathOf(key)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil {
		if isMissing(err) {
			directory.forgetSize(key)
			return nil
		}
		return deleteFailed(key, err)
	}
	directory.forgetSize(key)
	return syncDirectory(filepath.Dir(path))
}

func (directory *Directory) Move(from string, to string) error {
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
	if err := os.Rename(source, target); err != nil {
		return saveFailed(`Failed to move "`+from+`" to "`+to+`"`, to, err)
	}
	directory.forgetSize(from)
	measurePath(directory.sizesOf(to), to, target)
	if err := syncDirectory(filepath.Dir(target)); err != nil {
		return err
	}
	if filepath.Dir(source) != filepath.Dir(target) {
		return syncDirectory(filepath.Dir(source))
	}
	return nil
}

func (directory *Directory) List(prefix string) ([]string, error) {
	walkFrom := directory.root
	if slash := strings.LastIndexByte(prefix, '/'); slash >= 0 {
		path, err := directory.PathOf(prefix[:slash+1])
		if err != nil {
			return nil, err
		}
		walkFrom = path
	}
	var keys []string
	err := filepath.WalkDir(walkFrom, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			if isMissing(err) {
				return nil
			}
			return err
		}
		if entry.IsDir() {
			return nil
		}
		relative, err := filepath.Rel(directory.root, path)
		if err != nil {
			return err
		}
		key := filepath.ToSlash(relative)
		if strings.HasPrefix(key, prefix) {
			keys = append(keys, key)
		}
		return nil
	})
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, loadFailed(`Failed to list the keys under "`+prefix+`"`, prefix, err)
	}
	slices.Sort(keys)
	return keys, nil
}
