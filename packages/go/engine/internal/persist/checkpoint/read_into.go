package checkpoint

import (
	"context"
	"errors"
	"io"
	"io/fs"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/storage"
)

func unreadableListedFile(key string, what string, err error) error {
	return narsilerr.Wrap(narsilerr.CodePersistenceLoadFailed, `The `+what+` "`+key+`" cannot be read`, err,
		map[string]any{"key": key})
}

func ReadListedInto(ctx context.Context, store Store, ref manifest.FileRef, what string, buffer []byte) ([]byte, error) {
	path, located := store.PathOf(ref.Key)
	if !located || ref.Bytes > envelope.MaxFileBytes {
		return ReadListed(ctx, store, ref, what)
	}
	if err := ctx.Err(); err != nil {
		return nil, cancelled(ref.Key, err)
	}
	file, err := storage.OpenForReading(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, missingListedFile(ref.Key, what)
	}
	if err != nil {
		return nil, unreadableListedFile(ref.Key, what, err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, unreadableListedFile(ref.Key, what, err)
	}
	if err := manifest.RequireListedFile(ref, info.Size(), ref.Checksum, what); err != nil {
		return nil, err
	}
	if uint64(cap(buffer)) < ref.Bytes {
		buffer = make([]byte, ref.Bytes)
	}
	data := buffer[:ref.Bytes]
	if _, err := io.ReadFull(file, data); err != nil {
		return nil, unreadableListedFile(ref.Key, what, err)
	}
	return data, nil
}

func StoredSegmentFrom(ref manifest.FileRef, data []byte, pagedText bool) (StoredSegment, error) {
	if pagedText && holdsPagedText(data) {
		return openPaged(ref, data)
	}
	segment, err := openKeyword(ref, data)
	if err != nil {
		return nil, err
	}
	return keywordStored{segment: segment}, nil
}
