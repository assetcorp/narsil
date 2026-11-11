package persist

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"strings"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/checkpoint"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/storage"
)

const (
	restoreJournalPrefix = ".swap-"
	restoreStagingPrefix = ".restore-"
	retiredIndexPrefix   = ".retired-"
)

type restoreStorage struct {
	store     checkpoint.Store
	directory *storage.Directory
}

func (manager *Manager) restoreStorage() restoreStorage {
	return restoreStorage{store: manager.store, directory: manager.directory}
}

func journalKey(name string) string {
	return restoreJournalPrefix + codec.SHA256Hex([]byte(name))
}

func randomSuffix() string {
	random := make([]byte, restoreSuffixRandomBytes)
	_, _ = rand.Read(random)
	return hex.EncodeToString(random)
}

func isNameCharacter(character byte, first bool) bool {
	switch {
	case character >= 'a' && character <= 'z', character >= 'A' && character <= 'Z', character >= '0' && character <= '9':
		return true
	case first:
		return false
	}
	return character == '.' || character == '_' || character == '-'
}

func isIndexName(name string) bool {
	if name == "" || len(name) > MaxIndexNameLength || strings.Contains(name, "..") {
		return false
	}
	for at := range len(name) {
		if !isNameCharacter(name[at], at == 0) {
			return false
		}
	}
	return true
}

func isStagingPrefix(prefix string) bool {
	if len(prefix) < 3 || prefix[0] != '.' || !strings.HasSuffix(prefix, "/") || strings.Contains(prefix, "..") {
		return false
	}
	body := prefix[1 : len(prefix)-1]
	for at := range len(body) {
		if !isNameCharacter(body[at], at == 0) {
			return false
		}
	}
	return true
}

func corruptJournal(key string, reason string) error {
	return narsilerr.New(narsilerr.CodePersistenceLoadFailed, `The restore journal "`+key+`" `+reason,
		map[string]any{"key": key})
}

func readJournal(key string, data []byte) (string, string, bool, error) {
	text := string(data)
	name, prefix, _ := strings.Cut(text, "\n")
	if strings.TrimPrefix(key, restoreJournalPrefix) != codec.SHA256Hex([]byte(name)) {
		return "", "", false, nil
	}
	if !isIndexName(name) {
		return "", "", false, corruptJournal(key, "names an index that no index name can match")
	}
	if !isStagingPrefix(prefix) || prefix == storage.LockFileName+"/" {
		return "", "", false, corruptJournal(key, "names no staging prefix that a restore writes")
	}
	return name, prefix, true, nil
}

func listedRestoreKeys(ctx context.Context, restore restoreStorage, name string, prefix string) (map[string]struct{},
	error) {
	data, found, err := restore.store.Read(ctx, prefix+"manifest")
	if err == nil && !found {
		data, found, err = restore.store.Read(ctx, manifest.ManifestKey(name))
	}
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, narsilerr.New(narsilerr.CodePersistenceLoadFailed,
			`The restore of index "`+name+`" lost its manifest, both from staging and from the index`,
			map[string]any{"indexName": name, "stagingPrefix": prefix})
	}
	opened, err := manifest.Open(data)
	if err != nil {
		return nil, err
	}
	if manifest.IsEarlier(opened.Payload) {
		return nil, narsilerr.New(narsilerr.CodePersistenceLoadFailed,
			`The restore of index "`+name+`" staged a manifest in the layout of an earlier release`,
			map[string]any{"indexName": name})
	}
	listed, err := manifest.FromPayload(opened.Payload, name)
	if err != nil {
		return nil, err
	}
	keys := map[string]struct{}{"meta": {}, "manifest": {}}
	for _, key := range listed.ListedKeys() {
		keys[strings.TrimPrefix(key, name+"/")] = struct{}{}
	}
	return keys, nil
}

func finishJournal(ctx context.Context, restore restoreStorage, name string, prefix string) (string, error) {
	root := name + "/"
	listed, err := listedRestoreKeys(ctx, restore, name, prefix)
	if err != nil {
		return "", err
	}
	staged, err := restore.store.List(ctx, prefix)
	if err != nil {
		return "", err
	}
	retired := ""
	if restore.directory != nil && len(staged) > 0 {
		retired = retiredIndexPrefix + randomSuffix() + "/"
		if err := restore.directory.MoveTree(name, strings.TrimSuffix(retired, "/")); err != nil {
			return "", err
		}
		if err := restore.directory.MoveTree(strings.TrimSuffix(prefix, "/"), name); err != nil {
			return "", err
		}
	} else if err := copyStagedKeys(ctx, restore.store, staged, listed, prefix, root); err != nil {
		return "", err
	}
	present, err := restore.store.List(ctx, root)
	if err != nil {
		return "", err
	}
	for _, key := range present {
		if _, kept := listed[strings.TrimPrefix(key, root)]; kept {
			continue
		}
		if err := restore.store.Remove(ctx, key); err != nil {
			return "", err
		}
	}
	return retired, restore.store.Remove(ctx, journalKey(name))
}

func copyStagedKeys(ctx context.Context, store checkpoint.Store, staged []string, listed map[string]struct{},
	prefix string, root string) error {
	for _, key := range staged {
		relative := strings.TrimPrefix(key, prefix)
		if _, kept := listed[relative]; !kept {
			continue
		}
		data, found, err := store.Read(ctx, key)
		if err != nil {
			return err
		}
		if !found {
			continue
		}
		if err := store.Write(ctx, root+relative, data); err != nil {
			return err
		}
		if err := store.Remove(ctx, key); err != nil {
			return err
		}
	}
	return nil
}

func removePrefix(ctx context.Context, restore restoreStorage, prefix string) error {
	if restore.directory != nil {
		return restore.directory.RemoveTree(prefix)
	}
	keys, err := restore.store.List(ctx, prefix)
	if err != nil {
		return err
	}
	for _, key := range keys {
		if err := restore.store.Remove(ctx, key); err != nil {
			return err
		}
	}
	return nil
}

func removeStagingPrefixes(ctx context.Context, restore restoreStorage) error {
	keys, err := restore.store.List(ctx, ".")
	if err != nil {
		return err
	}
	prefixes := map[string]struct{}{}
	var order []string
	for _, key := range keys {
		slash := strings.IndexByte(key, '/')
		if slash == -1 || !isStagingPrefix(key[:slash+1]) {
			continue
		}
		if _, seen := prefixes[key[:slash+1]]; !seen {
			prefixes[key[:slash+1]] = struct{}{}
			order = append(order, key[:slash+1])
		}
	}
	for _, prefix := range order {
		if err := removePrefix(ctx, restore, prefix); err != nil {
			return err
		}
	}
	return nil
}

func (manager *Manager) finishRestoreJournals(ctx context.Context) error {
	restore := manager.restoreStorage()
	keys, err := restore.store.List(ctx, restoreJournalPrefix)
	if err != nil {
		return err
	}
	for _, key := range keys {
		if strings.Contains(key, "/") {
			continue
		}
		data, found, err := restore.store.Read(ctx, key)
		if err != nil {
			return err
		}
		if !found {
			continue
		}
		name, prefix, current, err := readJournal(key, data)
		if err != nil {
			return err
		}
		if !current {
			if err := restore.store.Remove(ctx, key); err != nil {
				return err
			}
			continue
		}
		if _, err := finishJournal(ctx, restore, name, prefix); err != nil {
			return err
		}
	}
	return removeStagingPrefixes(ctx, restore)
}
