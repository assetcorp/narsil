package projection

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
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

func (p Projection) Clone(document *model.Document) *model.Document {
	switch p.kind {
	case model.ProjectNoFields:
		return model.NewDocument()
	case model.ProjectSelectedFields:
	default:
		return CopyDocument(document)
	}
	if document == nil {
		return model.NewDocument()
	}
	if !p.includeList {
		if kept, isDocument := cloneExcept(document, nil, p.exclude).(*model.Document); isDocument && kept != nil {
			return kept
		}
		return model.NewDocument()
	}
	projected := model.NewDocument()
	for _, path := range p.include {
		if coveredByAny(p.exclude, path) {
			continue
		}
		found := ReadPath(document, path)
		if !found.Found {
			continue
		}
		writePath(projected, path, cloneExcept(found.Value, path, p.exclude))
	}
	return projected
}

func (p Projection) CopyVectorsInto(document *model.Document, fieldPaths []string,
	vectorOf func(fieldPath string) ([]float32, bool, error)) error {
	for _, fieldPath := range fieldPaths {
		if !p.KeepsField(fieldPath) {
			continue
		}
		vector, held, err := vectorOf(fieldPath)
		if err != nil {
			return err
		}
		if !held {
			continue
		}
		codec.PutHeldPath(document, fieldPath, append([]float32{}, vector...))
	}
	return nil
}
