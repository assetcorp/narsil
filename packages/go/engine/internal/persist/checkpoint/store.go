package checkpoint

import (
	"context"
	"io"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/storage"
)

type Store interface {
	Read(ctx context.Context, key string) ([]byte, bool, error)
	Size(ctx context.Context, key string) (int64, bool, error)
	Write(ctx context.Context, key string, chunks ...[]byte) error
	Remove(ctx context.Context, key string) error
	List(ctx context.Context, prefix string) ([]string, error)
	PathOf(key string) (string, bool)
}

type StreamingStore interface {
	WriteStream(ctx context.Context, key string, write func(io.Writer) error) error
}

type DirectoryStore struct {
	Directory *storage.Directory
}

func (store DirectoryStore) WriteStream(ctx context.Context, key string, write func(io.Writer) error) error {
	if err := ctx.Err(); err != nil {
		return cancelled(key, err)
	}
	return store.Directory.AtomicWriteStream(key, write)
}

func (store DirectoryStore) Read(ctx context.Context, key string) ([]byte, bool, error) {
	if err := ctx.Err(); err != nil {
		return nil, false, cancelled(key, err)
	}
	data, err := store.Directory.Read(key)
	return data, data != nil, err
}

func (store DirectoryStore) Size(ctx context.Context, key string) (int64, bool, error) {
	if err := ctx.Err(); err != nil {
		return 0, false, cancelled(key, err)
	}
	return store.Directory.Size(key)
}

func (store DirectoryStore) Write(ctx context.Context, key string, chunks ...[]byte) error {
	if err := ctx.Err(); err != nil {
		return cancelled(key, err)
	}
	return store.Directory.AtomicWrite(key, chunks...)
}

func (store DirectoryStore) Remove(ctx context.Context, key string) error {
	if err := ctx.Err(); err != nil {
		return cancelled(key, err)
	}
	return store.Directory.Remove(key)
}

func (store DirectoryStore) List(ctx context.Context, prefix string) ([]string, error) {
	if err := ctx.Err(); err != nil {
		return nil, cancelled(prefix, err)
	}
	return store.Directory.List(prefix)
}

func (store DirectoryStore) PathOf(key string) (string, bool) {
	path, err := store.Directory.PathOf(key)
	return path, err == nil
}

type AdapterStore struct {
	Adapter storage.Adapter
}

func wrapAdapter(code string, message string, key string, err error) error {
	if err == nil {
		return nil
	}
	if _, typed := narsilerr.As(err); typed {
		return err
	}
	return narsilerr.Wrap(code, message, err, map[string]any{"key": key})
}

func (store AdapterStore) Read(ctx context.Context, key string) ([]byte, bool, error) {
	data, found, err := store.Adapter.Load(ctx, key)
	return data, found, wrapAdapter(narsilerr.CodePersistenceLoadFailed, `Failed to load "`+key+`"`, key, err)
}

func (store AdapterStore) Size(ctx context.Context, key string) (int64, bool, error) {
	data, found, err := store.Read(ctx, key)
	return int64(len(data)), found, err
}

func (store AdapterStore) Write(ctx context.Context, key string, chunks ...[]byte) error {
	data := chunks[0]
	if len(chunks) != 1 {
		total := 0
		for _, chunk := range chunks {
			total += len(chunk)
		}
		data = make([]byte, 0, total)
		for _, chunk := range chunks {
			data = append(data, chunk...)
		}
	}
	return wrapAdapter(narsilerr.CodePersistenceSaveFailed, `Failed to save "`+key+`"`, key,
		store.Adapter.Save(ctx, key, data))
}

func (store AdapterStore) Remove(ctx context.Context, key string) error {
	return wrapAdapter(narsilerr.CodePersistenceDeleteFailed, `Failed to delete "`+key+`"`, key,
		store.Adapter.Delete(ctx, key))
}

func (store AdapterStore) List(ctx context.Context, prefix string) ([]string, error) {
	keys, err := store.Adapter.List(ctx, prefix)
	return keys, wrapAdapter(narsilerr.CodePersistenceLoadFailed, `Failed to list "`+prefix+`"`, prefix, err)
}

func (store AdapterStore) PathOf(string) (string, bool) {
	return "", false
}

func cancelled(key string, err error) error {
	return narsilerr.Wrap(narsilerr.CodePersistenceLoadFailed, `The work on "`+key+`" was cancelled`, err,
		map[string]any{"key": key})
}

func missingListedFile(key string, what string) error {
	return narsilerr.New(narsilerr.CodePersistenceLoadFailed,
		`The `+what+` "`+key+`" that the manifest lists is missing`, map[string]any{"key": key})
}

func ReadListed(ctx context.Context, store Store, ref manifest.FileRef, what string) ([]byte, error) {
	if ref.Bytes > envelope.MaxFileBytes {
		return nil, narsilerr.New(narsilerr.CodePersistenceLoadFailed,
			`The manifest lists the `+what+` "`+ref.Key+`" at `+strconv.FormatUint(ref.Bytes, 10)+
				" bytes, above the file size limit", map[string]any{"key": ref.Key})
	}
	size, found, err := store.Size(ctx, ref.Key)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, missingListedFile(ref.Key, what)
	}
	if uint64(size) != ref.Bytes {
		return nil, manifest.RequireListedFile(ref, size, ref.Checksum, what)
	}
	data, found, err := store.Read(ctx, ref.Key)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, missingListedFile(ref.Key, what)
	}
	if err := manifest.RequireListedFile(ref, int64(len(data)), ref.Checksum, what); err != nil {
		return nil, err
	}
	return data, nil
}

func RequireChecksum(ref manifest.FileRef, header envelope.Header, what string) error {
	return manifest.RequireListedFile(ref, int64(ref.Bytes), header.Checksum, what)
}
