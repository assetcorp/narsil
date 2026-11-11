package persist

import (
	"context"
	"io"
	"path/filepath"
	"strings"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/archive"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/checkpoint"
)

type stagedStore struct {
	base   checkpoint.Store
	root   string
	prefix string
}

func (store stagedStore) staged(key string) (string, error) {
	relative, found := strings.CutPrefix(key, store.root)
	if !found {
		return "", narsilerr.New(narsilerr.CodePersistenceSaveFailed,
			`A restore of "`+strings.TrimSuffix(store.root, "/")+`" cannot stage "`+key+`"`, map[string]any{"key": key})
	}
	return store.prefix + relative, nil
}

func (store stagedStore) Read(ctx context.Context, key string) ([]byte, bool, error) {
	staged, err := store.staged(key)
	if err != nil {
		return nil, false, err
	}
	return store.base.Read(ctx, staged)
}

func (store stagedStore) Size(ctx context.Context, key string) (int64, bool, error) {
	staged, err := store.staged(key)
	if err != nil {
		return 0, false, err
	}
	return store.base.Size(ctx, staged)
}

func (store stagedStore) Write(ctx context.Context, key string, chunks ...[]byte) error {
	staged, err := store.staged(key)
	if err != nil {
		return err
	}
	return store.base.Write(ctx, staged, chunks...)
}

func (store stagedStore) WriteStream(ctx context.Context, key string, write func(io.Writer) error) error {
	staged, err := store.staged(key)
	if err != nil {
		return err
	}
	streaming, streams := store.base.(checkpoint.StreamingStore)
	if !streams {
		return narsilerr.New(narsilerr.CodePersistenceSaveFailed,
			`The store under a restore of "`+strings.TrimSuffix(store.root, "/")+`" cannot stream "`+key+`"`,
			map[string]any{"key": key})
	}
	return streaming.WriteStream(ctx, staged, write)
}

func (store stagedStore) Remove(ctx context.Context, key string) error {
	staged, err := store.staged(key)
	if err != nil {
		return err
	}
	return store.base.Remove(ctx, staged)
}

func (store stagedStore) List(ctx context.Context, prefix string) ([]string, error) {
	staged, err := store.staged(prefix)
	if err != nil {
		return nil, err
	}
	keys, err := store.base.List(ctx, staged)
	if err != nil {
		return nil, err
	}
	for at, key := range keys {
		keys[at] = store.root + strings.TrimPrefix(key, store.prefix)
	}
	return keys, nil
}

func (store stagedStore) PathOf(key string) (string, bool) {
	staged, err := store.staged(key)
	if err != nil {
		return "", false
	}
	return store.base.PathOf(staged)
}

type restoreStaging struct {
	restore   restoreStorage
	name      string
	prefix    string
	store     stagedStore
	committed bool
	retired   string
}

func (manager *Manager) stageRestore(name string) *restoreStaging {
	restore := manager.restoreStorage()
	prefix := restoreStagingPrefix + randomSuffix() + "/"
	return &restoreStaging{restore: restore, name: name, prefix: prefix,
		store: stagedStore{base: restore.store, root: name + "/", prefix: prefix}}
}

func (staging *restoreStaging) writeStreamed(ctx context.Context, key string, size int64, body io.Reader) error {
	staged, err := staging.store.staged(key)
	if err != nil {
		return err
	}
	directory := staging.restore.directory
	if directory == nil {
		data, err := io.ReadAll(io.LimitReader(body, size))
		if err != nil {
			return narsilerr.Passthrough(err, narsilerr.CodePersistenceLoadFailed,
				`The archive entry for "`+key+`" cannot be read`)
		}
		return staging.restore.store.Write(ctx, staged, data)
	}
	receiving := staged + ".receiving"
	if err := directory.Remove(receiving); err != nil {
		return err
	}
	handle, err := directory.OpenAppend(receiving)
	if err != nil {
		return err
	}
	buffer := make([]byte, min(size, archive.FileChunkBytes))
	for remaining := size; remaining > 0; {
		read, err := io.ReadFull(body, buffer[:min(remaining, int64(len(buffer)))])
		if err != nil {
			_ = handle.Close()
			return narsilerr.Passthrough(err, narsilerr.CodePersistenceLoadFailed,
				`The archive entry for "`+key+`" cannot be read`)
		}
		if err := handle.Append(buffer[:read]); err != nil {
			_ = handle.Close()
			return err
		}
		remaining -= int64(read)
	}
	if err := handle.Sync(); err != nil {
		_ = handle.Close()
		return err
	}
	if err := handle.Close(); err != nil {
		return err
	}
	return directory.Move(receiving, staged)
}

func (staging *restoreStaging) commit(ctx context.Context) error {
	err := staging.restore.store.Write(ctx, journalKey(staging.name), []byte(staging.name+"\n"+staging.prefix))
	if err == nil {
		staging.committed = true
		return nil
	}
	if removal := staging.restore.store.Remove(ctx, journalKey(staging.name)); removal != nil {
		staging.committed = true
	}
	return err
}

func (staging *restoreStaging) finish(ctx context.Context) error {
	retired, err := finishJournal(ctx, staging.restore, staging.name, staging.prefix)
	staging.retired = retired
	return err
}

func (staging *restoreStaging) relocation(ctx context.Context) func(string) string {
	directory := staging.restore.directory
	if directory == nil {
		return nil
	}
	if left, err := staging.restore.store.List(ctx, staging.prefix); err != nil || len(left) > 0 {
		return nil
	}
	from, err := directory.PathOf(strings.TrimSuffix(staging.prefix, "/"))
	if err != nil {
		return nil
	}
	to, err := directory.PathOf(staging.name)
	if err != nil {
		return nil
	}
	return func(path string) string {
		rest, under := strings.CutPrefix(path, from)
		if !under || (rest != "" && rest[0] != filepath.Separator) {
			return path
		}
		return to + rest
	}
}

func (staging *restoreStaging) removeRetired(ctx context.Context) {
	if staging.retired == "" {
		return
	}
	_ = removePrefix(ctx, staging.restore, staging.retired)
	staging.retired = ""
}

func (staging *restoreStaging) discard(ctx context.Context) {
	if staging.committed {
		return
	}
	_ = removePrefix(ctx, staging.restore, staging.prefix)
}
