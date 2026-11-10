package persist

import (
	"bytes"
	"context"
	"io"
	"strings"
	"sync"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/archive"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/checkpoint"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/storage"
)

type Archive struct {
	Manifest      manifest.Manifest
	name          string
	manifestBytes []byte
	store         checkpoint.Store
	release       func()
	pagedText     bool
}

func openArchive(ctx context.Context, store checkpoint.Store, name string, release func()) (*Archive, error) {
	data, found, err := store.Read(ctx, manifest.ManifestKey(name))
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, narsilerr.New(narsilerr.CodePersistenceSaveFailed, `Index "`+name+`" holds no checkpoint`,
			map[string]any{"indexName": name})
	}
	opened, err := manifest.Open(data)
	if err != nil {
		return nil, err
	}
	if manifest.IsEarlier(opened.Payload) {
		return nil, narsilerr.New(narsilerr.CodePersistenceSaveFailed, `Index "`+name+`" holds an earlier layout`,
			map[string]any{"indexName": name})
	}
	listed, err := manifest.FromPayload(opened.Payload, name)
	if err != nil {
		return nil, err
	}
	return &Archive{Manifest: listed, name: name, manifestBytes: data, store: store, release: release}, nil
}

func (durable *Durable) OpenArchive(ctx context.Context) (*Archive, error) {
	durable.heldFiles.Add(1)
	var once sync.Once
	release := func() { once.Do(func() { durable.heldFiles.Add(-1) }) }
	if err := durable.checkpoint(ctx, true); err != nil {
		release()
		return nil, err
	}
	opened, err := openArchive(ctx, durable.manager.store, durable.handle.Name, release)
	if err != nil {
		release()
		return nil, err
	}
	opened.pagedText = durable.textStoredOnDisk()
	return opened, nil
}

func ArchiveFromMemory(ctx context.Context, handle *Handle) (*Archive, error) {
	for _, field := range handle.vectorFields() {
		if err := field.CompleteGraph(ctx); err != nil {
			return nil, err
		}
	}
	held := capture{seqNos: make([]uint64, handle.Index.PartitionCount())}
	every := make([]bool, len(held.seqNos))
	for at := range every {
		every[at] = true
	}
	partitions, err := buildPartitions(ctx, handle, held.seqNos, every)
	if err != nil {
		return nil, err
	}
	held.partitions = partitions
	if held.vectors, err = planVectors(ctx, handle, nil, true); err != nil {
		return nil, err
	}
	defer held.release()
	meta, err := handle.metadata(uint64(handle.Index.Count()))
	if err != nil {
		return nil, err
	}
	store := checkpoint.AdapterStore{Adapter: storage.NewMemory()}
	written, err := checkpoint.WriteFiles(ctx, store, checkpointInput(handle, meta, nil, held))
	if err != nil {
		return nil, err
	}
	if err := compactWritten(ctx, store, handle, nil, &written, DefaultCompactionThreshold, false); err != nil {
		return nil, err
	}
	if err := checkpoint.CommitManifest(ctx, store, handle.Name, written); err != nil {
		return nil, err
	}
	return openArchive(ctx, store, handle.Name, func() {})
}

func (opened *Archive) Release() {
	opened.release()
}

func (opened *Archive) openFile(ctx context.Context, ref manifest.FileRef) (io.ReadCloser, error) {
	if path, located := opened.store.PathOf(ref.Key); located {
		file, err := storage.OpenForReading(path)
		if err == nil {
			if info, statErr := file.Stat(); statErr == nil && uint64(info.Size()) == ref.Bytes {
				return file, nil
			}
			_ = file.Close()
		}
	}
	data, err := checkpoint.ReadListed(ctx, opened.store, ref, "checkpoint file")
	if err != nil {
		return nil, narsilerr.Passthrough(err, narsilerr.CodePersistenceSaveFailed,
			`The checkpoint file "`+ref.Key+`" cannot be read into the archive`)
	}
	return io.NopCloser(bytes.NewReader(data)), nil
}

func (opened *Archive) Write(ctx context.Context, destination io.Writer, config []byte, history HistoryEntries) error {
	writer := archive.NewWriter(destination)
	if err := writer.WriteConfig(config); err != nil {
		return err
	}
	if err := writer.WriteManifest(opened.manifestBytes); err != nil {
		return err
	}
	root := opened.name + "/"
	for _, ref := range opened.Manifest.Files() {
		if err := ctx.Err(); err != nil {
			return narsilerr.Wrap(narsilerr.CodePersistenceSaveFailed, "The snapshot archive was cancelled", err, nil)
		}
		body, err := opened.openFile(ctx, *ref)
		if err != nil {
			return err
		}
		err = writer.WriteFile(strings.TrimPrefix(ref.Key, root), int64(ref.Bytes), body)
		_ = body.Close()
		if err != nil {
			return err
		}
	}
	if err := writeHistory(ctx, writer, history); err != nil {
		return err
	}
	return writer.Close()
}
