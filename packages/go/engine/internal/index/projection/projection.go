package projection

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

type Projection struct {
	kind        model.DocumentProjectionKind
	include     [][]string
	includeList bool
	exclude     [][]string
}

func Whole() Projection {
	return Projection{kind: model.ProjectWholeDocument}
}

func Resolve(requested model.DocumentProjection) Projection {
	switch requested.Kind() {
	case model.ProjectNoFields:
		return Projection{kind: model.ProjectNoFields}
	case model.ProjectSelectedFields:
	default:
		return Whole()
	}
	include, includeSet := requested.Include()
	exclude := requested.Exclude()
	askedInclude := includeSet && len(include) > 0
	if !askedInclude && len(exclude) == 0 {
		return Whole()
	}
	resolved := Projection{kind: model.ProjectSelectedFields, exclude: splitPaths(exclude)}
	if askedInclude {
		resolved.include = splitPaths(include)
		resolved.includeList = true
	}
	return resolved
}

func (p Projection) Kind() model.DocumentProjectionKind {
	return p.kind
}

func (p Projection) HasIncludeList() bool {
	return p.kind == model.ProjectSelectedFields && p.includeList
}

func (p Projection) IncludedPaths() [][]string {
	paths := make([][]string, len(p.include))
	for position, path := range p.include {
		paths[position] = append([]string(nil), path...)
	}
	return paths
}

func (p Projection) KeepsField(fieldPath string) bool {
	switch p.kind {
	case model.ProjectNoFields:
		return false
	case model.ProjectSelectedFields:
	default:
		return true
	}
	path := splitFieldPath(fieldPath)
	if len(path) == 0 {
		return false
	}
	if p.includeList && !p.includeOverlaps(path) {
		return false
	}
	return !coveredByAny(p.exclude, path)
}

func (p Projection) includeOverlaps(path []string) bool {
	for _, included := range p.include {
		if overlaps(included, path) {
			return true
		}
	}
	return false
}

func (p Projection) Clone(document model.Document) model.Document {
	switch p.kind {
	case model.ProjectNoFields:
		return model.Document{}
	case model.ProjectSelectedFields:
	default:
		return CopyDocument(document)
	}
	if !p.includeList {
		if kept, isMap := cloneExcept(map[string]any(document), nil, p.exclude).(map[string]any); isMap && kept != nil {
			return kept
		}
		return model.Document{}
	}
	return p.projectIncludedPaths(func(_ int, path []string) PathRead { return ReadPath(document, path) })
}

func (p Projection) ProjectReader(document func() model.Document, read func(position int, path []string) PathRead) model.Document {
	if p.HasIncludeList() {
		return p.projectIncludedPaths(read)
	}
	if p.kind == model.ProjectNoFields {
		return model.Document{}
	}
	return p.Clone(document())
}

func (p Projection) projectIncludedPaths(read func(position int, path []string) PathRead) model.Document {
	projected := model.Document{}
	for position, path := range p.include {
		if coveredByAny(p.exclude, path) {
			continue
		}
		found := read(position, path)
		if !found.Found {
			continue
		}
		writePath(projected, path, cloneExcept(found.Value, path, p.exclude))
	}
	return projected
}

func (p Projection) CopyVectorsInto(document model.Document, fieldPaths []string, vectorOf func(fieldPath string) ([]float32, bool)) {
	for _, fieldPath := range fieldPaths {
		if !p.KeepsField(fieldPath) {
			continue
		}
		vector, held := vectorOf(fieldPath)
		if !held {
			continue
		}
		writeFieldPath(document, fieldPath, append([]float32{}, vector...))
	}
}

func (p Projection) Apply(document model.Document) model.Document {
	switch p.kind {
	case model.ProjectNoFields:
		return model.Document{}
	case model.ProjectSelectedFields:
	default:
		return document
	}
	projected := document
	if p.includeList {
		projected = model.Document{}
		for _, path := range p.include {
			if found := ReadPath(document, path); found.Found {
				writePath(projected, path, found.Value)
			}
		}
	}
	for _, path := range p.exclude {
		if omitted, isMap := omitPath(map[string]any(projected), path).(map[string]any); isMap {
			projected = omitted
		}
	}
	return projected
}

func omitPath(source any, path []string) any {
	segment := path[0]
	child, found := ownValue(source, segment)
	if !found {
		return source
	}
	copied := recordCopy(source)
	if len(path) == 1 {
		delete(copied, segment)
		return copied
	}
	if !isRecord(child) {
		return copied
	}
	copied[segment] = omitPath(child, path[1:])
	return copied
}
