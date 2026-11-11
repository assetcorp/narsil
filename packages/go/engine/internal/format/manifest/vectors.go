package manifest

import (
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/form"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

func (reader manifestReader) vectorFields(list []any) []VectorFieldRef {
	seen := make(map[string]bool, len(list))
	fields := make([]VectorFieldRef, 0, len(list))
	for index := range list {
		path := indexed("vectors", index)
		raw := reader.root.Element(list, "vectors", index)
		fieldPath := raw.String("fieldPath")
		if reader.root.Err() != nil {
			return nil
		}
		if seen[fieldPath] {
			reader.root.Fail(path+".fieldPath", "lists the vector field \""+fieldPath+"\" twice")
			return nil
		}
		seen[fieldPath] = true
		if !validFieldPath(fieldPath) {
			reader.root.Fail(path+".fieldPath", "holds characters that no segment key can carry")
			return nil
		}
		field := VectorFieldRef{
			FieldPath:  fieldPath,
			NextFileID: raw.Uint("nextFileId", MaxSegmentID),
		}
		files := raw.List("files")
		field.GraphGeneration = raw.Uint("graphGeneration", MaxSegmentID)
		if reader.root.Err() != nil {
			return nil
		}
		field.Files = reader.vectorFiles(raw, files, path, field)
		field.GraphParts = reader.graphParts(raw, path, field)
		if reader.root.Err() != nil {
			return nil
		}
		fields = append(fields, field)
	}
	return fields
}

func (reader manifestReader) vectorFiles(raw *form.Fields, list []any, path string, field VectorFieldRef) []VectorFileRef {
	seen := make(map[uint64]bool, len(list))
	files := make([]VectorFileRef, 0, len(list))
	for index := range list {
		at := indexed(path+".files", index)
		entry := raw.Element(list, "files", index)
		file := VectorFileRef{ID: entry.Uint("id", MaxSegmentID)}
		if reader.root.Err() != nil {
			return nil
		}
		if file.ID >= field.NextFileID || seen[file.ID] {
			reader.root.Fail(at+".id", "lists vector file "+strconv.FormatUint(file.ID, 10)+" of \""+field.FieldPath+
				"\" twice or at its next file id")
			return nil
		}
		seen[file.ID] = true
		file.Count = uint32(entry.Uint("count", MaxVectorFileVectors))
		if reader.root.Err() != nil {
			return nil
		}
		file.Dead = reader.dead(entry, at, file.Count)
		key, err := VectorFileKey(reader.mode.indexName, field.FieldPath, file.ID)
		if err != nil {
			reader.root.Fail(at+".key", "belongs to a field path that no segment key can carry")
			return nil
		}
		file.File = reader.fileRef(entry, at, key, "vector file")
		files = append(files, file)
	}
	return files
}

func (reader manifestReader) dead(entry *form.Fields, path string, count uint32) model.Optional[[]byte] {
	if !entry.HasValue("dead") {
		return model.Optional[[]byte]{}
	}
	dead, isBytes := entry.Value("dead").([]byte)
	if !isBytes {
		reader.root.Fail(path+".dead", "is not bytes")
		return model.Optional[[]byte]{}
	}
	if len(dead) != DeadBytesFor(count) {
		reader.root.Fail(path+".dead", "marks the dead vectors with "+strconv.Itoa(len(dead))+" bytes where "+
			strconv.Itoa(DeadBytesFor(count))+" belong")
		return model.Optional[[]byte]{}
	}
	return model.Some(dead)
}

func (reader manifestReader) graphParts(raw *form.Fields, path string, field VectorFieldRef) []FileRef {
	list := raw.List("graphParts")
	if reader.root.Err() != nil {
		return nil
	}
	if len(list) > 0 && field.GraphGeneration == 0 {
		reader.root.Fail(path+".graphParts", "lists graph parts at generation 0")
		return nil
	}
	parts := make([]FileRef, 0, len(list))
	for index := range list {
		at := indexed(path+".graphParts", index)
		entry := raw.Element(list, "graphParts", index)
		key, err := GraphPartKey(reader.mode.indexName, field.FieldPath, field.GraphGeneration, uint64(index))
		if err != nil {
			reader.root.Fail(at+".key", "belongs to a graph generation that no segment key can carry")
			return nil
		}
		parts = append(parts, reader.fileRef(entry, at, key, "graph part"))
		if reader.root.Err() != nil {
			return nil
		}
	}
	return parts
}
