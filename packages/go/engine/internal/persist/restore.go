package persist

import (
	"context"
	"io"
	"strings"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/archive"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/indexconfig"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/metadata"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/checkpoint"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/storage"
)

type Restoring struct {
	IndexName      string
	Configuration  indexconfig.Configuration
	Manifest       manifest.Manifest
	PartitionCount int
	Replaces       bool
}

type RestoreHooks struct {
	Admit   func(ctx context.Context, restoring Restoring) error
	Create  func(ctx context.Context, restoring Restoring) (*Handle, error)
	History func(ctx context.Context, restoring Restoring) (HistorySink, error)
	Swap    func(ctx context.Context) error
}

type fileWriter func(ctx context.Context, key string, size int64, body io.Reader) error

func invalidArchive(message string) error {
	return narsilerr.New(narsilerr.CodePersistenceLoadFailed, "Invalid snapshot archive: "+message, nil)
}

func renamed(listed manifest.Manifest, sourceName string, name string) manifest.Manifest {
	rename := func(key string) string { return name + "/" + strings.TrimPrefix(key, sourceName+"/") }
	for _, ref := range listed.Files() {
		ref.Key = rename(ref.Key)
	}
	return listed
}

func requireSameSchema(configured map[string]string, listed map[string]string) error {
	for _, fields := range []map[string]string{configured, listed} {
		for field := range fields {
			configuredType, inConfiguration := configured[field]
			listedType, inManifest := listed[field]
			if inConfiguration && inManifest && configuredType == listedType {
				continue
			}
			return narsilerr.New(narsilerr.CodePersistenceLoadFailed,
				`The archive's configuration gives field "`+field+`" another type than its manifest does`,
				map[string]any{"field": field})
		}
	}
	return nil
}

func partitionCountOf(listed manifest.Manifest) int {
	count := 1
	for _, entry := range listed.Partitions {
		count = max(count, int(entry.PartitionID)+1)
	}
	return count
}

type archiveRead struct {
	name          string
	hooks         RestoreHooks
	replaces      bool
	write         fileWriter
	restoring     Restoring
	listed        bool
	history       HistorySink
	historyOpened bool
}

func (read *archiveRead) config(data []byte) error {
	config, _, err := indexconfig.Read(data, indexconfig.ArchiveReject)
	if err != nil {
		return err
	}
	read.restoring.IndexName, read.restoring.Configuration = read.name, config
	return nil
}

func (read *archiveRead) manifest(ctx context.Context, data []byte) ([]archive.ListedFile, error) {
	opened, err := manifest.Open(data)
	if err != nil {
		return nil, err
	}
	sourceName, err := manifest.SourceIndexName(manifest.ListedKeys(opened.Payload))
	if err != nil {
		return nil, err
	}
	if manifest.IsEarlier(opened.Payload) {
		return nil, invalidArchive("the manifest holds the layout of an earlier release")
	}
	listed, err := manifest.FromPayload(opened.Payload, sourceName)
	if err != nil {
		return nil, err
	}
	if err := requireSameSchema(read.restoring.Configuration.Schema, listed.Schema); err != nil {
		return nil, err
	}
	files := make([]archive.ListedFile, 0, len(listed.Files()))
	for _, ref := range listed.Files() {
		files = append(files, archive.ListedFile{Name: strings.TrimPrefix(ref.Key, sourceName+"/"),
			Bytes: int64(ref.Bytes), Checksum: ref.Checksum})
	}
	read.restoring.Manifest = renamed(listed, sourceName, read.name)
	read.restoring.PartitionCount = partitionCountOf(listed)
	read.restoring.Replaces = read.replaces
	if read.hooks.Admit != nil {
		if err := read.hooks.Admit(ctx, read.restoring); err != nil {
			return nil, err
		}
	}
	read.listed = true
	return files, nil
}

func stageArchive(ctx context.Context, read *archiveRead, source io.Reader, store checkpoint.Store) (*Handle, error) {
	err := archive.Read(source, archive.Handlers{
		Config: read.config,
		Manifest: func(data []byte) ([]archive.ListedFile, error) {
			return read.manifest(ctx, data)
		},
		File: func(file archive.ListedFile, body io.Reader) error {
			return read.write(ctx, read.name+"/"+file.Name, file.Bytes, body)
		},
		History: func(_ int, body io.Reader) error {
			return read.addHistory(ctx, body)
		},
	})
	if err != nil {
		return nil, err
	}
	if !read.listed {
		return nil, invalidArchive("the archive holds no manifest")
	}
	encoded, err := manifest.Encode(read.restoring.Manifest, read.name, false)
	if err != nil {
		return nil, err
	}
	if err := store.Write(ctx, manifest.ManifestKey(read.name), encoded); err != nil {
		return nil, err
	}
	if err := requireStagedSegments(ctx, store, read.restoring.Manifest); err != nil {
		return nil, err
	}
	handle, err := read.hooks.Create(ctx, read.restoring)
	if err != nil {
		return nil, err
	}
	if handle.Index.PartitionCount() < read.restoring.PartitionCount {
		return nil, narsilerr.New(narsilerr.CodePersistenceLoadFailed,
			`The restored index "`+read.name+`" holds fewer partitions than its archive lists`,
			map[string]any{"indexName": read.name})
	}
	if err := LoadManifest(ctx, store, handle, read.restoring.Manifest); err != nil {
		return nil, err
	}
	return handle, nil
}

func RestoreArchive(ctx context.Context, name string, source io.Reader, hooks RestoreHooks) (*Handle, HistorySink,
	error) {
	if !isIndexName(name) || hooks.Create == nil {
		return nil, nil, narsilerr.New(narsilerr.CodeConfigInvalid,
			`A restore needs a valid index name and a way to create it`, map[string]any{"indexName": name})
	}
	reader, isEarlier := sniffEarlierSnapshot(source)
	if isEarlier {
		handle, _, err := buildEarlierSnapshot(ctx, name, reader, hooks, false)
		return handle, nil, err
	}
	store := checkpoint.AdapterStore{Adapter: storage.NewMemory()}
	read := &archiveRead{name: name, hooks: hooks,
		write: func(ctx context.Context, key string, size int64, body io.Reader) error {
			data, err := io.ReadAll(io.LimitReader(body, size))
			if err != nil {
				return narsilerr.Passthrough(err, narsilerr.CodePersistenceLoadFailed,
					`The archive entry for "`+key+`" cannot be read`)
			}
			return store.Write(ctx, key, data)
		}}
	handle, err := stageArchive(ctx, read, reader, store)
	if err != nil {
		read.abandonHistory(ctx)
		return nil, nil, err
	}
	return handle, read.history, nil
}

func appliedOf(listed manifest.Manifest, count int) []uint64 {
	applied := make([]uint64, count)
	for partitionID := range applied {
		applied[partitionID] = listed.LastSeqNo(uint32(partitionID))
	}
	return applied
}

func (manager *Manager) RestoreArchive(ctx context.Context, name string, source io.Reader, hooks RestoreHooks) (
	*Durable, HistorySink, error) {
	if !isIndexName(name) || hooks.Create == nil {
		return nil, nil, narsilerr.New(narsilerr.CodeConfigInvalid,
			`A restore needs a valid index name and a way to create it`, map[string]any{"indexName": name})
	}
	if err := manager.Fatal(); err != nil {
		return nil, nil, err
	}
	reader, isEarlier := sniffEarlierSnapshot(source)
	if isEarlier {
		durable, err := manager.restoreEarlierSnapshot(ctx, name, reader, hooks)
		return durable, nil, err
	}
	return manager.restoreArchive(ctx, name, reader, hooks)
}

func (manager *Manager) restoreArchive(ctx context.Context, name string, source io.Reader, hooks RestoreHooks) (
	*Durable, HistorySink, error) {
	staging := manager.stageRestore(name)
	defer staging.discard(ctx)
	_, replaces := manager.Get(name)
	read := &archiveRead{name: name, hooks: hooks, replaces: replaces, write: staging.writeStreamed}
	durable, err := manager.restoreStaged(ctx, read, source, staging)
	if err != nil {
		read.abandonHistory(ctx)
		return nil, nil, err
	}
	return durable, read.history, nil
}

func (manager *Manager) restoreStaged(ctx context.Context, read *archiveRead, source io.Reader,
	staging *restoreStaging) (*Durable, error) {
	name := read.name
	handle, err := stageArchive(ctx, read, source, staging.store)
	if err != nil {
		return nil, err
	}
	meta, err := handle.metadata(uint64(handle.Index.Count()))
	if err != nil {
		return nil, err
	}
	encoded, err := metadata.Write(meta, false, true)
	if err != nil {
		return nil, err
	}
	if err := staging.store.Write(ctx, metadataKey(name), encoded); err != nil {
		return nil, err
	}
	if read.hooks.Swap != nil {
		if err := read.hooks.Swap(ctx); err != nil {
			return nil, err
		}
	}
	return manager.installRestored(ctx, staging, handle, read.restoring.Manifest)
}

func (manager *Manager) installRestored(ctx context.Context, staging *restoreStaging, handle *Handle,
	listed manifest.Manifest) (*Durable, error) {
	for _, field := range handle.vectorFields() {
		if err := field.ReleaseVectorFiles(ctx); err != nil {
			return nil, err
		}
	}
	previous, replaces := manager.Get(handle.Name)
	var previousApplied []uint64
	if replaces {
		previousApplied = make([]uint64, len(previous.partitions))
		for partitionID := range previousApplied {
			previousApplied[partitionID] = previous.AppliedSeqNo(partitionID)
		}
		for _, field := range previous.handle.vectorFields() {
			_ = field.ReleaseVectorFiles(ctx)
		}
		closeErr := previous.close()
		manager.unregister(handle.Name)
		if closeErr != nil {
			manager.markFatal(closeErr)
			return nil, closeErr
		}
	}
	suspended := suspendBothPagedFiles(ctx, staging, handle, previous, replaces)
	if suspended != nil {
		if replaces {
			_ = manager.register(manager.newDurable(previous.handle, previousApplied))
		}
		return nil, suspended
	}
	if err := staging.finish(ctx); err != nil {
		manager.markFatal(err)
	}
	relocate := staging.relocation(ctx)
	if err := handle.Index.ResumePagedFiles(relocate); err != nil {
		manager.markFatal(err)
	}
	if relocate != nil {
		for _, field := range handle.vectorFields() {
			if err := field.RelocateVectorFiles(relocate); err != nil {
				manager.markFatal(err)
			}
		}
	}
	durable := manager.newDurable(handle, appliedOf(listed, handle.Index.PartitionCount()))
	if err := manager.register(durable); err != nil {
		return nil, err
	}
	staging.removeRetired(ctx)
	return durable, nil
}

func suspendBothPagedFiles(ctx context.Context, staging *restoreStaging, handle *Handle, previous *Durable,
	replaces bool) error {
	if replaces {
		if err := previous.handle.Index.SuspendPagedFiles(); err != nil {
			return err
		}
	}
	err := handle.Index.SuspendPagedFiles()
	if err == nil {
		err = staging.commit(ctx)
		if err != nil {
			_ = handle.Index.ResumePagedFiles(nil)
		}
	}
	if err != nil && replaces {
		_ = previous.handle.Index.ResumePagedFiles(nil)
	}
	return err
}
