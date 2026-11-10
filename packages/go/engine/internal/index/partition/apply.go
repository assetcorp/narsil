package partition

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/frozen"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

type operationKind uint8

const (
	insertDocument operationKind = iota
	removeDocument
	replaceDocumentText
	replaceDocumentValues
	clearDocuments
	tombstoneFrozenDocument
	moveFrozenDocument
	freezeTail
	swapSegments
)

type carriedTombstone struct {
	ordinal uint32
	text    analysedText
}

type operation struct {
	kind         operationKind
	next         *StoredDocument
	nextText     analysedText
	previous     *StoredDocument
	previousText analysedText
	segment      *frozen.Segment
	ordinal      uint32
	dropped      []*frozen.Segment
	carried      []carriedTombstone
}

func (s *side) frozenSubOf(segment *frozen.Segment) *frozenSub {
	for _, sub := range s.frozen {
		if sub.segment == segment {
			return sub
		}
	}
	return nil
}

func (s *side) withFrozenTail(segment *frozen.Segment) *side {
	next := s.successor()
	next.frozen = append(s.frozen[:len(s.frozen):len(s.frozen)], newFrozenSub(segment))
	next.postings.BeginBatch()
	return next
}

func (s *side) swapFrozen(dropped []*frozen.Segment, replacement *frozen.Segment, carried []carriedTombstone) {
	kept := make([]*frozenSub, 0, len(s.frozen))
	for _, sub := range s.frozen {
		drop := false
		for _, segment := range dropped {
			drop = drop || sub.segment == segment
		}
		if !drop {
			kept = append(kept, sub)
		}
	}
	if replacement == nil {
		s.frozen = kept
		return
	}
	added := newFrozenSub(replacement)
	for _, tombstone := range carried {
		added.tombstone(tombstone.ordinal, tombstone.text)
	}
	s.frozen = append(kept, added)
}

func (s *side) apply(operations []operation, fields []schema.Field) *side {
	current := s
	current.postings.BeginBatch()
	for index := range operations {
		op := &operations[index]
		switch op.kind {
		case insertDocument:
			current.insert(op.next, op.nextText, fields)
		case removeDocument:
			current.remove(op.previous, op.previousText, fields)
		case replaceDocumentText:
			current.remove(op.previous, op.previousText, fields)
			current.insert(op.next, op.nextText, fields)
		case replaceDocumentValues:
			current.replaceValues(op.previous, op.next, fields)
		case clearDocuments:
			current = current.successor()
			current.postings.BeginBatch()
		case tombstoneFrozenDocument, moveFrozenDocument:
			if sub := current.frozenSubOf(op.segment); sub != nil {
				sub.tombstone(op.ordinal, op.previousText)
			}
			if op.kind == moveFrozenDocument {
				current.insert(op.next, op.nextText, fields)
			}
		case freezeTail:
			current = current.withFrozenTail(op.segment)
		case swapSegments:
			current.swapFrozen(op.dropped, op.segment, op.carried)
		}
	}
	current.postings.EndBatch()
	current.settle()
	return current
}

func (s *side) insert(document *StoredDocument, text analysedText, fields []schema.Field) {
	ordinal := s.documents.store(document)
	s.indexText(ordinal, text)
	s.indexValues(ordinal, document.Fields, fields)
	s.statistics.addDocument(document.FieldLengths)
	s.partial.Apply(text.spellings, 1)
}

func (s *side) indexText(ordinal uint32, text analysedText) {
	for _, field := range text.fields {
		number := s.fieldNumber(field.path)
		for _, token := range field.tokens {
			s.postings.Insert(token.term, ordinal, token.count, number, token.positions, token.positions != nil)
		}
		for _, surface := range field.surfaces {
			s.surfaces.add(surface.surface, surface.token, surface.count)
		}
	}
}

func (s *side) remove(document *StoredDocument, text analysedText, fields []schema.Field) {
	_, ordinal, found := s.documents.get(document.ID)
	if !found {
		return
	}
	occurrences := map[string]uint32{}
	order := make([]string, 0)
	for _, field := range text.fields {
		for _, token := range field.tokens {
			if _, seen := occurrences[token.term]; !seen {
				order = append(order, token.term)
			}
			occurrences[token.term] += min(token.count, maxTermFrequency)
		}
		for _, surface := range field.surfaces {
			s.surfaces.subtract(surface.surface, surface.count)
		}
	}
	s.removeValues(ordinal, document.Fields, fields)
	for _, term := range order {
		s.postings.Remove(term, ordinal, occurrences[term])
	}
	s.documents.remove(document.ID)
	s.statistics.removeDocument(text.lengths)
	s.partial.Apply(text.spellings, -1)
}

func (s *side) replaceValues(previous, next *StoredDocument, fields []schema.Field) {
	_, ordinal, found := s.documents.get(previous.ID)
	if !found {
		return
	}
	for _, field := range fields {
		if field.IsWordIndexed() {
			continue
		}
		previousValue, previousPresent := presentValue(previous.Fields, field.Path)
		nextValue, nextPresent := presentValue(next.Fields, field.Path)
		if previousPresent == nextPresent && (!previousPresent || sameIndexedValue(previousValue, nextValue, 0)) {
			continue
		}
		single := []schema.Field{field}
		if previousPresent {
			s.removeValues(ordinal, previous.Fields, single)
		}
		if nextPresent {
			s.indexValues(ordinal, next.Fields, single)
		}
	}
	s.documents.store(next)
}

func sameIndexedValue(left, right any, depth int) bool {
	if depth > maxCompareDepth {
		return false
	}
	switch typed := left.(type) {
	case []any:
		other, isList := right.([]any)
		if !isList || len(other) != len(typed) {
			return false
		}
		for index := range typed {
			if !sameIndexedValue(typed[index], other[index], depth+1) {
				return false
			}
		}
		return true
	case map[string]any:
		other, isObject := right.(map[string]any)
		if !isObject || len(other) != len(typed) {
			return false
		}
		for key, value := range typed {
			otherValue, found := other[key]
			if !found || !sameIndexedValue(value, otherValue, depth+1) {
				return false
			}
		}
		return true
	case float64:
		other, isNumber := right.(float64)
		return isNumber && other == typed
	case string:
		other, isString := right.(string)
		return isString && other == typed
	case bool:
		other, isBool := right.(bool)
		return isBool && other == typed
	case nil:
		return right == nil
	}
	return false
}
