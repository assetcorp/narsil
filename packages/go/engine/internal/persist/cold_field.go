package persist

import (
	"context"
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/paged"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/checkpoint"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/storage"
	"github.com/assetcorp/narsil/packages/go/engine/internal/vector"
	"github.com/assetcorp/narsil/packages/go/engine/internal/vector/payload"
)

type coldHeld struct {
	native []*paged.NativeFile
	paged  []*paged.File
	paths  []string
	closed bool
}

type coldOpened struct {
	source coldSource
	file   *paged.File
	native *paged.NativeFile
}

func (held *coldHeld) close() {
	if held.closed {
		return
	}
	held.closed = true
	for _, file := range held.paged {
		file.Close()
	}
	for _, file := range held.native {
		_ = file.Close()
	}
}

func (opened coldOpened) pages(section paged.Section) core.PageSection {
	return opened.native.PageSection(section)
}

func (held *coldHeld) open(path string, key string) (coldOpened, error) {
	file, err := storage.OpenForReading(path)
	if err != nil {
		return coldOpened{}, narsilerr.Wrap(narsilerr.CodePersistenceLoadFailed,
			`The file "`+key+`" cannot be opened`, err, map[string]any{"key": key})
	}
	native, err := paged.OpenNativeFile(file, path)
	if err != nil {
		return coldOpened{}, err
	}
	held.native = append(held.native, native)
	held.paths = append(held.paths, path)
	opened := paged.OpenFile(native, key, paged.SharedReadCache())
	held.paged = append(held.paged, opened)
	return coldOpened{source: coldSource{reader: native, size: native.Size(), close: func() {}}, file: opened,
		native: native}, nil
}

func holdsEveryHead(ref manifest.VectorFieldRef) bool {
	if len(ref.GraphParts) == 0 || len(ref.Files) == 0 {
		return false
	}
	for _, file := range ref.Files {
		if !file.File.Head.IsSet() {
			return false
		}
	}
	return !slices.ContainsFunc(ref.GraphParts, func(part manifest.FileRef) bool { return !part.Head.IsSet() })
}

func requireListedSize(ctx context.Context, store checkpoint.Store, ref manifest.FileRef, what string) error {
	size, found, err := store.Size(ctx, ref.Key)
	if err != nil {
		return err
	}
	if !found {
		return narsilerr.New(narsilerr.CodePersistenceLoadFailed,
			`The `+what+` "`+ref.Key+`" that the manifest lists is missing`, map[string]any{"key": ref.Key})
	}
	return manifest.RequireListedFile(ref, size, ref.Checksum, what)
}

func coldSectionsOf(source coldSource, ref manifest.FileRef) (map[string]paged.Section, bool, error) {
	head, cold, err := coldHead(source, ref)
	if err != nil || !cold {
		return nil, false, err
	}
	list, err := paged.DecodeSectionsAllowing(head["sections"], source.size-envelope.HeaderBytes,
		`head of "`+ref.Key+`"`, vectorPageSizes)
	if err != nil {
		return nil, false, err
	}
	sections := make(map[string]paged.Section, len(list))
	for _, section := range list {
		sections[section.Name] = section
	}
	return sections, true, nil
}

func requiredColdSection(sections map[string]paged.Section, name string, key string) (paged.Section, error) {
	section, listed := sections[name]
	if !listed {
		return paged.Section{}, coldLoadFailed(`The head of "`+key+`" lists no section "`+name+`"`, key)
	}
	return section, nil
}

func sameColdCodes(left *coldCodes, right *coldCodes) bool {
	return left.bits == right.bits && slices.Equal(left.centroid, right.centroid)
}

func openColdFile(held *coldHeld, path string, ref manifest.VectorFileRef, codeBits uint32,
	codes *coldCodes) (vector.ColdGraphFile, *coldCodes, bool, error) {
	key := ref.File.Key
	opened, err := held.open(path, key)
	if err != nil {
		return vector.ColdGraphFile{}, nil, false, err
	}
	source := opened.source
	sections, cold, err := coldSectionsOf(source, ref.File)
	if err != nil || !cold {
		return vector.ColdGraphFile{}, nil, false, err
	}
	fileCodes, err := coldCodesOf(source, sections, key)
	if err != nil {
		return vector.ColdGraphFile{}, nil, false, err
	}
	if codeBits != 0 && (fileCodes == nil || fileCodes.bits != codeBits || (codes != nil && !sameColdCodes(codes, fileCodes))) {
		return vector.ColdGraphFile{}, nil, false, nil
	}
	magnitudes, err := requiredColdSection(sections, "magnitudes", key)
	if err != nil {
		return vector.ColdGraphFile{}, nil, false, err
	}
	if magnitudes.Length/float64Bytes != int64(ref.Count) {
		return vector.ColdGraphFile{}, nil, false, coldLoadFailed(`The file "`+key+`" holds the wrong number of magnitudes`, key)
	}
	graphFile := vector.ColdGraphFile{Key: key, Count: int(ref.Count), Path: path,
		Magnitudes: opened.file.Section(magnitudes)}
	if dead, marked := ref.Dead.Get(); marked {
		graphFile.Dead = dead
	}
	for _, named := range []struct {
		name   string
		target *vector.ColdSection
	}{{"docIds", &graphFile.IDs}, {"idOffsets", &graphFile.IDOffsets}, {"idOrder", &graphFile.IDOrder}, {"vectors", &graphFile.Vectors}} {
		section, err := requiredColdSection(sections, named.name, key)
		if err != nil {
			return vector.ColdGraphFile{}, nil, false, err
		}
		*named.target = opened.file.Section(section)
		if named.name == "vectors" {
			graphFile.VectorPages = opened.pages(section)
		}
	}
	if records, listed := sections["records"]; listed {
		recordPages := opened.pages(records)
		graphFile.RecordPages = &recordPages
	}
	if codeBits == 0 {
		return graphFile, nil, true, nil
	}
	return graphFile, fileCodes, true, nil
}

func openColdParts(held *coldHeld, store checkpoint.Store, ref manifest.VectorFieldRef) ([]vector.ColdGraphPart,
	coldGraphLayout, bool, error) {
	parts := make([]vector.ColdGraphPart, 0, len(ref.GraphParts))
	var first coldGraphLayout
	numbered := make([]payload.NumberedGraph, 0, len(ref.GraphParts))
	for at, partRef := range ref.GraphParts {
		path, located := store.PathOf(partRef.Key)
		if !located {
			return nil, first, false, nil
		}
		opened, err := held.open(path, partRef.Key)
		if err != nil {
			return nil, first, false, err
		}
		layout, cold, err := readColdGraphLayout(opened.source, partRef)
		if err != nil || !cold {
			return nil, first, false, err
		}
		if at == 0 {
			first = layout
		}
		numbered = append(numbered, payload.NumberedGraph{M: first.m, Levels: layout.levels})
		parts = append(parts, vector.ColdGraphPart{Levels: layout.levels, NodeOffsets: layout.nodeOffsets,
			NeighbourPages: opened.pages(layout.neighbours)})
	}
	err := payload.RequireBoundedUpperLists(payload.GraphParts{FieldName: ref.FieldPath,
		Graphs: []payload.NumberedGraphParts{{Parts: numbered}}})
	if err != nil {
		return nil, first, false, err
	}
	return parts, first, true, nil
}
