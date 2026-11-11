package partition

import (
	"slices"
	"strings"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/analysis"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/growing"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/segments"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

type preparedText struct {
	paths  []string
	fields []core.FieldTokens
	units  []uint16
}

func NestedValue(document *codec.Document, path string) (any, bool) {
	var current any = document
	for part := range strings.SplitSeq(path, ".") {
		object, isObject := current.(*codec.Document)
		if !isObject {
			return nil, false
		}
		value, found := codec.HeldValue(object, part)
		if !found {
			return nil, false
		}
		current = value
	}
	return current, true
}

func presentValue(document *codec.Document, path string) (any, bool) {
	value, found := NestedValue(document, path)
	return value, found && value != nil
}

func sameValue(left, right any) bool {
	switch typed := left.(type) {
	case string:
		other, isString := right.(string)
		return isString && other == typed
	case []any:
		other, isList := right.([]any)
		return isList && slices.EqualFunc(typed, other, sameValue)
	}
	return false
}

func stringItems(value any) []string {
	items, isList := value.([]any)
	if !isList {
		return nil
	}
	texts := make([]string, 0, len(items))
	for _, item := range items {
		if text, isString := item.(string); isString {
			texts = append(texts, text)
		}
	}
	return texts
}

type analyser struct {
	pass    *analysis.Pass
	options analysis.Options
	text    []schema.Field
}

func (a analyser) prepare(document *codec.Document) (preparedText, error) {
	var collected growing.Document
	for at, field := range a.text {
		value, present := presentValue(document, field.Path)
		if !present {
			continue
		}
		var err error
		if field.Base == schema.BaseString {
			text, isString := value.(string)
			if !isString {
				continue
			}
			err = collected.AddText(a.pass, a.options, uint16(at), text)
		} else {
			err = collected.AddList(a.pass, a.options, uint16(at), stringItems(value), ArrayPositionGap)
		}
		if err != nil {
			return preparedText{}, err
		}
	}
	return ownedText(collected.Fields(), a.text), nil
}

func ownedText(fields []core.FieldTokens, text []schema.Field) preparedText {
	prepared := preparedText{fields: make([]core.FieldTokens, len(fields)), paths: make([]string, len(fields))}
	for at, field := range fields {
		prepared.fields[at] = core.FieldTokens{Field: field.Field, Tokens: slices.Clone(field.Tokens)}
		prepared.paths[at] = text[field.Field].Path
		if prepared.units == nil {
			prepared.units = slices.Clone(field.Units)
		}
	}
	for at := range prepared.fields {
		prepared.fields[at].Units = prepared.units
	}
	return prepared
}

func (p preparedText) numbered(number func(path string) uint16) []core.FieldTokens {
	numbered := make([]core.FieldTokens, len(p.fields))
	for at, field := range p.fields {
		numbered[at] = core.FieldTokens{Field: number(p.paths[at]), Tokens: field.Tokens, Units: p.units}
	}
	slices.SortFunc(numbered, func(left, right core.FieldTokens) int { return int(left.Field) - int(right.Field) })
	return numbered
}

func (p preparedText) frozenTokens() []segments.Tokens {
	tokens := make([]segments.Tokens, len(p.fields))
	for at, field := range p.fields {
		tokens[at] = segments.Tokens{Field: p.paths[at], Records: field.Tokens, Units: p.units}
	}
	return tokens
}
