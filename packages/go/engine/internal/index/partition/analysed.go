package partition

import (
	"strings"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/analysis"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partialwords"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

type analysedToken struct {
	term      string
	count     uint32
	positions []uint32
}

type surfaceCount struct {
	surface string
	token   string
	count   int
}

type analysedField struct {
	path     string
	tokens   []analysedToken
	length   uint32
	surfaces []surfaceCount
}

type analysedText struct {
	fields           []analysedField
	lengths          map[string]uint32
	spellings        *partialwords.SpellingCounts
	removedSpellings *partialwords.RemovedSpellings
}

type Analysis struct {
	Pass            *analysis.Pass
	CollectSurfaces bool
	TrackPositions  bool
}

func NestedValue(document map[string]any, path string) (any, bool) {
	var current any = document
	for _, part := range strings.Split(path, ".") {
		object, isObject := current.(map[string]any)
		if !isObject {
			return nil, false
		}
		value, found := object[part]
		if !found {
			return nil, false
		}
		current = value
	}
	return current, true
}

func presentValue(document map[string]any, path string) (any, bool) {
	value, found := NestedValue(document, path)
	return value, found && value != nil
}

type fieldTokens struct {
	order     []string
	byTerm    map[string]*analysedToken
	surfaces  []surfaceCount
	bySurface map[string]int
	length    uint32
	positions bool
	spellings *partialwords.SpellingCounts
}

func newFieldTokens(positions bool) *fieldTokens {
	return &fieldTokens{byTerm: map[string]*analysedToken{}, bySurface: map[string]int{}, positions: positions}
}

func (f *fieldTokens) add(token analysis.Token, position int) {
	held := f.byTerm[token.Term]
	if held == nil {
		held = &analysedToken{term: token.Term}
		f.byTerm[token.Term] = held
		f.order = append(f.order, token.Term)
	}
	held.count++
	if f.positions {
		held.positions = append(held.positions, uint32(position))
	}
	f.length++
	if f.spellings != nil {
		f.spellings.CountToken(token)
	}
	if !token.HasSurface || token.Surface == "" {
		return
	}
	if at, found := f.bySurface[token.Surface]; found {
		f.surfaces[at].count++
		return
	}
	f.bySurface[token.Surface] = len(f.surfaces)
	f.surfaces = append(f.surfaces, surfaceCount{surface: token.Surface, token: token.Term, count: 1})
}

func (f *fieldTokens) field(path string) analysedField {
	tokens := make([]analysedToken, len(f.order))
	for index, term := range f.order {
		tokens[index] = *f.byTerm[term]
	}
	return analysedField{path: path, tokens: tokens, length: f.length, surfaces: f.surfaces}
}

func (a Analysis) options() analysis.Options {
	options := analysis.IndexingOptions
	options.CollectSurfaces = a.CollectSurfaces
	return options
}

func (a Analysis) analyseText(document map[string]any, fields []schema.Field) (analysedText, error) {
	analysed := analysedText{lengths: map[string]uint32{}}
	for _, field := range fields {
		if !field.IsWordIndexed() {
			continue
		}
		value, present := presentValue(document, field.Path)
		if !present {
			continue
		}
		collected := newFieldTokens(a.TrackPositions)
		if field.Partial {
			if analysed.spellings == nil {
				analysed.spellings = partialwords.NewSpellingCounts()
			}
			collected.spellings = analysed.spellings
		}
		var err error
		if field.Base == schema.BaseString {
			err = a.analyseString(value, collected)
		} else {
			err = a.analyseList(value, collected)
		}
		if err != nil {
			return analysedText{}, err
		}
		analysed.fields = append(analysed.fields, collected.field(field.Path))
		analysed.lengths[field.Path] = collected.length
	}
	return analysed, nil
}

func (a Analysis) analyseString(value any, collected *fieldTokens) error {
	written, isString := value.(string)
	if !isString {
		return nil
	}
	return a.Pass.Visit(written, a.options(), func(token analysis.Token) { collected.add(token, token.Position) })
}

func (a Analysis) analyseList(value any, collected *fieldTokens) error {
	items, isList := value.([]any)
	if !isList {
		return nil
	}
	offset := 0
	for _, item := range items {
		written, isString := item.(string)
		if !isString {
			continue
		}
		lastItemPosition := -1
		err := a.Pass.Visit(written, a.options(), func(token analysis.Token) {
			collected.add(token, offset+token.Position)
			lastItemPosition = token.Position
		})
		if err != nil {
			return err
		}
		if lastItemPosition >= 0 {
			offset += lastItemPosition + 1 + arrayPositionGap
		}
	}
	return nil
}
