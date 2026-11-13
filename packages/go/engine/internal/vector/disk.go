package vector

import (
	"context"
	"math"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

type pendingLocation struct {
	path   string
	offset int64
}

type VectorPartFile struct {
	Path          string
	VectorsOffset int64
}

type VectorFileLayout struct {
	VectorPartFile
	DocIDs []string
	Dead   []byte
}

func isDead(dead []byte, position int) bool {
	index := position >> 3
	return index < len(dead) && (dead[index]>>(position&7))&1 == 1
}

func (f *Field) readsFromDisk() bool {
	return f.config.storage == model.VectorStorageDisk
}

func (f *Field) holdsVectorsOnDisk() bool {
	return f.readsFromDisk() && f.graph != nil
}

type locatedVector struct {
	docID    string
	location pendingLocation
}

func (f *Field) locationsOf(layout VectorFileLayout) []locatedVector {
	stride := int64(f.config.dimension) * 4
	located := make([]locatedVector, 0, len(layout.DocIDs))
	for position, docID := range layout.DocIDs {
		if isDead(layout.Dead, position) {
			continue
		}
		offset := layout.VectorsOffset + int64(position)*stride
		located = append(located, locatedVector{docID: docID, location: pendingLocation{path: layout.Path, offset: offset}})
	}
	return located
}

func (f *Field) AdoptDiskLayout(ctx context.Context, layout VectorFileLayout) error {
	f.writeMu.Lock()
	if !f.readsFromDisk() || f.disposed || len(layout.DocIDs) == 0 {
		f.writeMu.Unlock()
		return nil
	}
	located := f.locationsOf(layout)
	if !f.holdsVectorsOnDisk() {
		defer f.writeMu.Unlock()
		for _, vector := range located {
			if f.store.has(vector.docID) {
				f.pendingLocations[vector.docID] = vector.location
			}
		}
		return nil
	}
	defer f.writeMu.Unlock()
	return f.releaseLocations(ctx, []string{layout.Path}, located)
}

func (f *Field) releasePendingLocations(ctx context.Context) error {
	f.writeMu.Lock()
	defer f.writeMu.Unlock()
	if len(f.pendingLocations) == 0 || !f.holdsVectorsOnDisk() || f.disposed {
		return nil
	}
	located := make([]locatedVector, 0, len(f.pendingLocations))
	paths := []string{}
	seen := map[string]struct{}{}
	for docID, location := range f.pendingLocations {
		located = append(located, locatedVector{docID: docID, location: location})
		if _, held := seen[location.path]; !held {
			seen[location.path] = struct{}{}
			paths = append(paths, location.path)
		}
	}
	clear(f.pendingLocations)
	return f.releaseLocations(ctx, paths, located)
}

func (f *Field) releaseLocations(ctx context.Context, paths []string, located []locatedVector) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	previous := f.store.tables
	locations, err := previous.locations.clone()
	if err != nil {
		return err
	}
	f.store.tables = previous.clone()
	f.store.tables.locations = locations
	committed := false
	var opened []*sharedResource
	defer func() {
		if committed {
			previous.locations.resource.drop()
			return
		}
		for _, resource := range opened {
			resource.drop()
		}
		f.store.tables = previous
		locations.resource.drop()
	}()
	indexes := make(map[string]int32, len(paths))
	for _, path := range paths {
		before := len(f.store.tables.files)
		index, err := f.store.addVectorFile(path)
		if err != nil {
			return err
		}
		indexes[path] = index
		if int(index) >= before {
			opened = append(opened, f.store.tables.files[index].resource)
		}
	}
	for _, vector := range located {
		ordinal, held := f.store.ordinalOf(vector.docID)
		index, known := indexes[vector.location.path]
		if !held || !known || vector.location.offset < 0 || vector.location.offset > math.MaxUint32 {
			continue
		}
		f.store.releaseToFile(ordinal, diskLocation{fileIndex: index, offset: uint32(vector.location.offset)})
	}
	next, dropped := f.store.releaseColdBlocks()
	if next != nil {
		f.store.tables = next
	}
	if err := f.publish(f.store, f.graph); err != nil {
		return err
	}
	committed = true
	for _, resource := range dropped {
		resource.drop()
	}
	return nil
}

func (f *Field) VectorFilesInUse() []string {
	f.writeMu.Lock()
	defer f.writeMu.Unlock()
	if f.disposed {
		return []string{}
	}
	paths := f.store.filePaths()
	for _, retired := range f.fileLayoutsInUse() {
		for _, file := range retired.tables.files {
			if file != nil && file.path != "" {
				paths = append(paths, file.path)
			}
		}
	}
	if f.cold != nil {
		paths = append(paths, f.cold.field.FilePaths()...)
	}
	return paths
}

func (f *Field) ReleaseVectorFiles(ctx context.Context) error {
	if err := f.untilColdLoaded(ctx); err != nil {
		return err
	}
	f.writeMu.Lock()
	defer f.writeMu.Unlock()
	if f.disposed {
		return nil
	}
	next, dropped := f.store.closedFiles()
	f.store.tables = next
	f.filesClosed.Store(len(f.store.filePaths()) > 0)
	for _, resource := range dropped {
		resource.drop()
	}
	return f.publishAndDrain(ctx)
}

func (f *Field) RelocateVectorFiles(rewrite func(path string) string) error {
	f.writeMu.Lock()
	defer f.writeMu.Unlock()
	if f.disposed {
		return nil
	}
	for docID, location := range f.pendingLocations {
		f.pendingLocations[docID] = pendingLocation{path: rewrite(location.path), offset: location.offset}
	}
	if !f.filesClosed.Load() {
		return f.swapFiles(rewrite)
	}
	next := f.store.tables.clone()
	for index, file := range next.files {
		if file != nil && file.path != "" {
			next.files[index] = &mappedVectorFile{path: rewrite(file.path)}
		}
	}
	f.store.tables = next
	return f.publish(f.store, f.graph)
}

func (f *Field) ensureFilesOpen() error {
	if !f.filesClosed.Load() {
		return nil
	}
	return f.reopenVectorFiles()
}

func (f *Field) swapFiles(rewrite func(path string) string) error {
	next, dropped, err := f.store.reopenedFiles(rewrite)
	if err != nil {
		return err
	}
	f.store.tables = next
	if err := f.publish(f.store, f.graph); err != nil {
		return err
	}
	for _, resource := range dropped {
		resource.drop()
	}
	f.filesClosed.Store(false)
	return nil
}

func (f *Field) reopenVectorFiles() error {
	f.writeMu.Lock()
	defer f.writeMu.Unlock()
	if !f.filesClosed.Load() || f.disposed {
		return nil
	}
	return f.swapFiles(nil)
}
