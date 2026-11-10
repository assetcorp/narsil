package persist

import (
	"bufio"
	"context"
	"errors"
	"io"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/earlier"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/indexconfig"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

const nrslMagic = "NRSL"

func sniffEarlierSnapshot(source io.Reader) (*bufio.Reader, bool) {
	reader := bufio.NewReader(source)
	head, _ := reader.Peek(len(nrslMagic))
	return reader, string(head) == nrslMagic
}

func readEarlierSnapshot(reader *bufio.Reader) ([]byte, error) {
	head, _ := reader.Peek(envelope.HeaderBytes)
	header, err := envelope.ParseHeader(head)
	if err != nil {
		return nil, err
	}
	length := int64(envelope.HeaderBytes) + int64(header.PayloadLength)
	if length > envelope.MaxFileBytes {
		return nil, narsilerr.New(narsilerr.CodePersistenceLoadFailed, "The snapshot declares "+
			strconv.FormatInt(length, 10)+" bytes, above the file size limit of "+
			strconv.FormatInt(envelope.MaxFileBytes, 10), map[string]any{"bytes": length})
	}
	data, err := io.ReadAll(io.LimitReader(reader, length))
	if err != nil {
		return nil, narsilerr.Passthrough(err, narsilerr.CodePersistenceLoadFailed, "The snapshot cannot be read")
	}
	if int64(len(data)) < length {
		return nil, narsilerr.New(narsilerr.CodePersistenceLoadFailed,
			"The snapshot ends before the payload its header declares", nil)
	}
	if _, err := reader.ReadByte(); err == nil {
		return nil, narsilerr.New(narsilerr.CodePersistenceLoadFailed,
			"The snapshot holds bytes after the payload its header declares", nil)
	} else if !errors.Is(err, io.EOF) {
		return nil, narsilerr.Passthrough(err, narsilerr.CodePersistenceLoadFailed, "The snapshot cannot be read")
	}
	return data, nil
}

func disposeVectors(handle *Handle) {
	for _, field := range handle.vectorFields() {
		field.Dispose()
	}
}

func buildEarlierSnapshot(ctx context.Context, name string, reader *bufio.Reader, hooks RestoreHooks,
	replaces bool) (*Handle, Restoring, error) {
	data, err := readEarlierSnapshot(reader)
	if err != nil {
		return nil, Restoring{}, err
	}
	snapshot, err := earlier.DecodeIndexSnapshot(data)
	if err != nil {
		return nil, Restoring{}, err
	}
	config, err := indexconfig.Decode(snapshot.Payload, "index snapshot", indexconfig.ArchiveReject)
	if err != nil {
		return nil, Restoring{}, err
	}
	config.VectorPromotion = raiseEarlierReleaseGraphM(config.VectorPromotion)
	restoring := Restoring{IndexName: name, Configuration: config, PartitionCount: max(1, len(snapshot.Partitions)),
		Replaces: replaces}
	if hooks.Admit != nil {
		if err := hooks.Admit(ctx, restoring); err != nil {
			return nil, Restoring{}, err
		}
	}
	handle, err := hooks.Create(ctx, restoring)
	if err != nil {
		return nil, Restoring{}, err
	}
	if err := insertEarlierDocuments(handle, snapshot.Partitions, snapshot.VectorIndexes); err != nil {
		disposeVectors(handle)
		return nil, Restoring{}, err
	}
	for _, field := range handle.vectorFields() {
		field.ScheduleBuild()
	}
	return handle, restoring, nil
}

func archiveOfEarlierSnapshot(ctx context.Context, handle *Handle, restoring Restoring, targetBytes int64) (
	io.ReadCloser, func() error, error) {
	built, err := ArchiveFromMemory(ctx, handle, targetBytes)
	if err != nil {
		return nil, nil, err
	}
	config, err := indexconfig.Write(restoring.Configuration, false)
	if err != nil {
		built.Release()
		return nil, nil, err
	}
	reader, writer := io.Pipe()
	written := make(chan error, 1)
	go func() {
		err := built.Write(ctx, writer, config, nil)
		built.Release()
		_ = writer.CloseWithError(err)
		written <- err
	}()
	wait := func() error {
		_ = reader.Close()
		return <-written
	}
	return reader, wait, nil
}

func (manager *Manager) restoreEarlierSnapshot(ctx context.Context, name string, reader *bufio.Reader,
	hooks RestoreHooks) (*Durable, error) {
	_, replaces := manager.Get(name)
	detached, restoring, err := buildEarlierSnapshot(ctx, name, reader, hooks, replaces)
	if err != nil {
		return nil, err
	}
	defer disposeVectors(detached)
	source, wait, err := archiveOfEarlierSnapshot(ctx, detached, restoring, manager.settings.TargetSegmentBytes)
	if err != nil {
		return nil, err
	}
	restored, _, err := manager.restoreArchive(ctx, name, source, RestoreHooks{Create: hooks.Create, Swap: hooks.Swap})
	_ = wait()
	return restored, err
}
