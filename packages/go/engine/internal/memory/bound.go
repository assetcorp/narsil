package memory

import (
	"math"
	"strings"
	"unicode/utf8"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

type TermVisitor func(text string, visit func(term string)) error

type textField struct {
	path    []string
	partial bool
	pattern bool
}

type vectorField struct {
	path      []string
	joined    string
	dimension int
	embedded  bool
}

type Shape struct {
	text         []textField
	enums        [][]string
	vectors      []vectorField
	vectorPaths  map[string]struct{}
	termsPerUnit float64
	customTerms  TermVisitor
	countedTerms TermVisitor
}

func NewShape(fields []schema.Field, ngramSize uint32, embeddedPaths map[string]struct{},
	customTerms, countedTerms TermVisitor) *Shape {
	shape := &Shape{vectorPaths: map[string]struct{}{}, termsPerUnit: singleClassTermsPerUnit,
		customTerms: customTerms, countedTerms: countedTerms}
	if ngramSize >= 1 {
		shape.termsPerUnit = ngramTermsPerUnit
	}
	for _, field := range fields {
		path := strings.Split(field.Path, ".")
		switch field.Base {
		case schema.BaseString, schema.BaseStringList:
			shape.text = append(shape.text, textField{path: path, partial: field.Partial, pattern: field.Pattern})
		case schema.BaseEnum, schema.BaseEnumList:
			shape.enums = append(shape.enums, path)
		case schema.BaseVector:
			_, embedded := embeddedPaths[field.Path]
			shape.vectors = append(shape.vectors, vectorField{path: path, joined: field.Path, dimension: field.Dimension,
				embedded: embedded})
			shape.vectorPaths[field.Path] = struct{}{}
		}
	}
	return shape
}

func nestedValue(document *codec.Document, path []string) (any, bool) {
	var current any = document
	for _, part := range path {
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
	return current, current != nil
}

func utf16Units(text string) float64 {
	units := 0
	for at := 0; at < len(text); {
		if text[at] < utf8.RuneSelf {
			units++
			at++
			continue
		}
		character, size := utf8.DecodeRuneInString(text[at:])
		units++
		if character > 0xFFFF {
			units++
		}
		at += size
	}
	return float64(units)
}

func textsOf(value any) []string {
	switch typed := value.(type) {
	case string:
		return []string{typed}
	case []string:
		return typed
	case []any:
		texts := make([]string, 0, len(typed))
		for _, item := range typed {
			if text, isText := item.(string); isText {
				texts = append(texts, text)
			}
		}
		return texts
	}
	return nil
}

func valueCountOf(value any) float64 {
	switch typed := value.(type) {
	case nil:
		return 0
	case []any:
		return float64(len(typed))
	case []string:
		return float64(len(typed))
	}
	return 1
}

func (s *Shape) valueHeapBytes(value any, depth int, path string) float64 {
	switch typed := value.(type) {
	case string:
		return documentValueHeapBytes + float64(len(typed))*documentHeapBytesPerEstimatedByte
	case []byte:
		return documentValueHeapBytes + float64(len(typed))*documentHeapBytesPerEstimatedByte
	case codec.Extension:
		return documentValueHeapBytes + float64(len(typed.Data))*documentHeapBytesPerEstimatedByte
	case []float32:
		return documentValueHeapBytes + float64(len(typed))*float32Bytes*documentHeapBytesPerEstimatedByte
	case []float64:
		return documentValueHeapBytes + float64(len(typed))*float64Bytes*documentHeapBytesPerEstimatedByte
	}
	if depth > codec.MaxDocumentEncodingDepth {
		return documentValueHeapBytes
	}
	bytes := float64(documentValueHeapBytes)
	switch typed := value.(type) {
	case []string:
		for _, item := range typed {
			bytes += s.valueHeapBytes(item, depth+1, "")
		}
	case []any:
		for _, item := range typed {
			bytes += s.valueHeapBytes(item, depth+1, "")
		}
	case *codec.Document:
		for key, item := range codec.HeldEntries(typed) {
			bytes += documentPropertyHeapBytes + float64(len(key))*documentHeapBytesPerEstimatedByte
			keyPath := ""
			if len(s.vectorPaths) > 0 && (path != "" || depth == 1) {
				keyPath = key
				if path != "" {
					keyPath = path + "." + key
				}
				if _, isVector := s.vectorPaths[keyPath]; isVector {
					continue
				}
			}
			bytes += s.valueHeapBytes(item, depth+1, keyPath)
		}
	}
	return bytes
}

func termBytesOf(partial bool) float64 {
	if partial {
		return distinctTermHeapBytes + partialSpellingHeapBytes
	}
	return distinctTermHeapBytes
}

func (s *Shape) builtInTermBytes(text string, partial bool) float64 {
	normalizedUnits := utf16Units(text) * normalizationExpansionFactor
	terms := math.Ceil((normalizedUnits + 1) * s.termsPerUnit)
	return terms*termBytesOf(partial) + normalizedUnits*termUnitHeapBytes
}

func customTermBytes(visitor TermVisitor, text string, partial bool) (float64, error) {
	bytes := 0.0
	err := visitor(text, func(term string) {
		bytes += termBytesOf(partial) + utf16Units(term)*termUnitHeapBytes
	})
	return bytes, err
}

func countedTermBytes(visitor TermVisitor, text string, partial bool) (float64, error) {
	distinct := map[string]struct{}{}
	units := 0.0
	err := visitor(text, func(term string) {
		distinct[term] = struct{}{}
		units += utf16Units(term)
	})
	return float64(len(distinct))*termBytesOf(partial) + units*termUnitHeapBytes, err
}

type textTermBytes func(text string, partial bool) (float64, error)

func (s *Shape) boundWith(document *codec.Document, termBytes textTermBytes) (float64, error) {
	bytes := s.valueHeapBytes(document, 1, "")
	for _, field := range s.vectors {
		if _, present := nestedValue(document, field.path); present || field.embedded {
			bytes += vectorDocumentHeapBytes + float64(field.dimension)*vectorComponentHeapBytes
		}
	}
	for _, field := range s.text {
		value, present := nestedValue(document, field.path)
		if !present {
			continue
		}
		for _, text := range textsOf(value) {
			terms, err := termBytes(text, field.partial)
			if err != nil {
				return 0, err
			}
			bytes += terms
			if field.pattern {
				bytes += utf16Units(text) * caseFoldExpansionFactor * patternRunHeapBytes
			}
		}
	}
	for _, path := range s.enums {
		if value, present := nestedValue(document, path); present {
			bytes += valueCountOf(value) * enumValueHeapBytes
		}
	}
	return bytes, nil
}

func (s *Shape) Bound(document *codec.Document) float64 {
	termBytes := func(text string, partial bool) (float64, error) {
		if s.customTerms != nil {
			return customTermBytes(s.customTerms, text, partial)
		}
		return s.builtInTermBytes(text, partial), nil
	}
	bound, err := s.boundWith(document, termBytes)
	if err != nil {
		return 0
	}
	return bound
}

func (s *Shape) CountedBound(document *codec.Document) (float64, bool) {
	if s.countedTerms == nil {
		return 0, false
	}
	termBytes := func(text string, partial bool) (float64, error) {
		return countedTermBytes(s.countedTerms, text, partial)
	}
	bound, err := s.boundWith(document, termBytes)
	return bound, err == nil
}
