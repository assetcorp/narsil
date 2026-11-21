package projection

import (
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

type Projection struct {
	kind        model.DocumentProjectionKind
	vectors     model.Optional[bool]
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
		return wholeWithVectors(requested)
	}
	include, includeSet := requested.Include()
	exclude := requested.Exclude()
	askedInclude := includeSet && len(include) > 0
	if !askedInclude && len(exclude) == 0 {
		return wholeWithVectors(requested)
	}
	resolved := Projection{kind: model.ProjectSelectedFields, exclude: splitPaths(exclude)}
	if returned, set := requested.Vectors(); set {
		resolved.vectors = model.Some(returned)
	}
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
	return p.keepsPath(splitFieldPath(fieldPath))
}

func (p Projection) keepsPath(path []string) bool {
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

func (p Projection) Failure(document *model.Document) error {
	switch {
	case p.kind == model.ProjectNoFields:
		return nil
	case p.kind != model.ProjectSelectedFields || !p.includeList:
		return codec.StoredDocumentFailure(document)
	}
	for _, path := range p.include {
		if coveredByAny(p.exclude, path) {
			continue
		}
		if err := codec.StoredPathFailure(document, path, false); err != nil {
			return err
		}
	}
	return nil
}

func wholeWithVectors(requested model.DocumentProjection) Projection {
	whole := Whole()
	if returned, set := requested.Vectors(); set {
		whole.vectors = model.Some(returned)
	}
	return whole
}

func (p Projection) includesExactly(path []string) bool {
	for _, included := range p.include {
		if slices.Equal(included, path) {
			return true
		}
	}
	return false
}

func (p Projection) showsVector(fieldPath string, returnedByDefault bool) bool {
	switch p.kind {
	case model.ProjectNoFields:
		return false
	case model.ProjectSelectedFields:
	default:
		return p.vectors.Or(returnedByDefault)
	}
	path := splitFieldPath(fieldPath)
	returned, set := p.vectors.Get()
	if !set {
		returned = returnedByDefault || (p.includeList && p.includesExactly(path))
	}
	return returned && p.keepsPath(path)
}

func (p Projection) ShownVectorFields(fieldPaths []string, returnedByDefault bool) []string {
	shownCount := 0
	for _, fieldPath := range fieldPaths {
		if p.showsVector(fieldPath, returnedByDefault) {
			shownCount++
		}
	}
	switch shownCount {
	case 0:
		return nil
	case len(fieldPaths):
		return fieldPaths
	}
	shown := make([]string, 0, shownCount)
	for _, fieldPath := range fieldPaths {
		if p.showsVector(fieldPath, returnedByDefault) {
			shown = append(shown, fieldPath)
		}
	}
	return shown
}

func CopyVectorsInto(document *model.Document, shownFieldPaths []string,
	vectorOf func(fieldPath string) ([]float32, bool, error)) error {
	for _, fieldPath := range shownFieldPaths {
		vector, held, err := vectorOf(fieldPath)
		if err != nil {
			return err
		}
		if !held {
			continue
		}
		codec.PutHeldPath(document, fieldPath, vector)
	}
	return nil
}
