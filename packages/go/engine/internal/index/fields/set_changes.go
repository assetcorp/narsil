package fields

import "github.com/assetcorp/narsil/packages/go/engine/internal/schema"

type fieldChange struct {
	field      schema.Field
	oldPresent bool
	newPresent bool
	oldValue   any
	newValue   any
}

type jsonKind uint8

const (
	jsonKindNull jsonKind = iota
	jsonKindNumber
	jsonKindString
	jsonKindBoolean
	jsonKindObject
	jsonKindOther
)

func jsonKindOf(value any) jsonKind {
	if value == nil {
		return jsonKindNull
	}
	if _, isNumber := numberOf(value); isNumber {
		return jsonKindNumber
	}
	switch value.(type) {
	case string:
		return jsonKindString
	case bool:
		return jsonKindBoolean
	case []any, map[string]any:
		return jsonKindObject
	}
	return jsonKindOther
}

func strictlyEqual(left, right any) bool {
	kind := jsonKindOf(left)
	if kind != jsonKindOf(right) {
		return false
	}
	switch kind {
	case jsonKindNull:
		return true
	case jsonKindNumber:
		leftNumber, _ := numberOf(left)
		rightNumber, _ := numberOf(right)
		return leftNumber == rightNumber
	case jsonKindString:
		return left.(string) == right.(string)
	case jsonKindBoolean:
		return left.(bool) == right.(bool)
	}
	return false
}

func unchangedValue(oldValue any, oldFound bool, newValue any, newFound bool) bool {
	if !oldFound || !newFound {
		return !oldFound && !newFound
	}
	if strictlyEqual(oldValue, newValue) {
		return true
	}
	if oldValue == nil || newValue == nil || jsonKindOf(oldValue) != jsonKindOf(newValue) {
		return false
	}
	return jsonEqual(oldValue, newValue)
}

func jsonNormal(value any) any {
	if number, isNumber := numberOf(value); isNumber {
		if !isFinite(number) {
			return nil
		}
		return number
	}
	return value
}

func jsonEqual(left, right any) bool {
	left, right = jsonNormal(left), jsonNormal(right)
	switch typed := left.(type) {
	case nil:
		return right == nil
	case float64:
		number, isNumber := right.(float64)
		return isNumber && number == typed
	case string:
		text, isText := right.(string)
		return isText && text == typed
	case bool:
		flag, isFlag := right.(bool)
		return isFlag && flag == typed
	case []any:
		list, isList := right.([]any)
		if !isList || len(list) != len(typed) {
			return false
		}
		for at := range typed {
			if !jsonEqual(typed[at], list[at]) {
				return false
			}
		}
		return true
	case map[string]any:
		object, isObject := right.(map[string]any)
		if !isObject || len(object) != len(typed) {
			return false
		}
		for key, value := range typed {
			other, held := object[key]
			if !held || !jsonEqual(value, other) {
				return false
			}
		}
		return true
	}
	return false
}

func (s *Set) validateChanges(changes []fieldChange) error {
	for _, change := range changes {
		if change.oldPresent {
			if err := s.validateValue(change.field, change.oldValue); err != nil {
				return err
			}
		}
		if change.newPresent {
			if err := s.validateValue(change.field, change.newValue); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *Set) prepareChanges(ordinal uint32, changes []fieldChange) error {
	written := make([]fieldValue, 0, len(changes))
	for _, change := range changes {
		if change.newPresent {
			written = append(written, fieldValue{field: change.field, value: change.newValue})
		}
	}
	return s.prepareInserts(ordinal, written)
}

func (s *Set) applyChanges(ordinal uint32, changes []fieldChange) error {
	var first error
	for _, change := range changes {
		if change.oldPresent {
			if err := s.applyRemoval(ordinal, change.field, change.oldValue); err != nil && first == nil {
				first = err
			}
		}
		if change.newPresent {
			if err := s.applyInsert(ordinal, change.field, change.newValue); err != nil && first == nil {
				first = err
			}
		}
	}
	return first
}
