package narsil

import (
	"bytes"
	"encoding/json"
	"fmt"
	"reflect"
	"slices"
)

type variantShape struct {
	required []string
	known    []string
	open     bool
}

func jsonKindOf(data []byte) string {
	trimmed := bytes.TrimLeft(data, " \t\r\n")
	if len(trimmed) == 0 {
		return ""
	}
	switch trimmed[0] {
	case '"':
		return "string"
	case '{':
		return "object"
	case '[':
		return "array"
	case 't', 'f':
		return "bool"
	case 'n':
		return "null"
	}
	return "number"
}

func chooseVariant(data []byte, shapes []variantShape) int {
	var fields map[string]json.RawMessage
	if json.Unmarshal(data, &fields) != nil {
		return -1
	}
	holdsRequired := func(shape variantShape) bool {
		for _, key := range shape.required {
			if _, present := fields[key]; !present {
				return false
			}
		}
		return true
	}
	for position, shape := range shapes {
		if !holdsRequired(shape) {
			continue
		}
		if shape.open {
			return position
		}
		allKnown := true
		for key := range fields {
			if !slices.Contains(shape.known, key) {
				allKnown = false
				break
			}
		}
		if allKnown {
			return position
		}
	}
	for position, shape := range shapes {
		if holdsRequired(shape) {
			return position
		}
	}
	return -1
}

func isSet(choice any) bool {
	value := reflect.ValueOf(choice)
	switch value.Kind() {
	case reflect.Pointer, reflect.Slice, reflect.Map, reflect.Interface:
		return !value.IsNil()
	case reflect.Invalid:
		return false
	}
	return true
}

func marshalUnion(name string, choices ...any) ([]byte, error) {
	var chosen any
	set := 0
	for _, choice := range choices {
		if isSet(choice) {
			set++
			chosen = choice
		}
	}
	if set != 1 {
		return nil, fmt.Errorf("narsil: a %s must have exactly one field set, and this one has %d", name, set)
	}
	return json.Marshal(chosen)
}

func unionMismatch(name string, data []byte) error {
	preview := data
	if len(preview) > 80 {
		preview = preview[:80]
	}
	return fmt.Errorf("narsil: the JSON %s fits none of the forms of %s", preview, name)
}

// Nullable holds an optional value that can also be null, for the few settings where null carries a
// separate meaning, such as resetting a setting to its default.
//
// The zero Nullable leaves the setting out of the request. Null sends null, and Value sends the value.
type Nullable[T any] struct {
	value T
	state nullableState
}

type nullableState uint8

const (
	nullableAbsent nullableState = iota
	nullableNull
	nullablePresent
)

// Null returns a Nullable that sends null.
func Null[T any]() Nullable[T] {
	return Nullable[T]{state: nullableNull}
}

// Value returns a Nullable that sends value.
func Value[T any](value T) Nullable[T] {
	return Nullable[T]{value: value, state: nullablePresent}
}

// Get returns the value and true when the Nullable holds one.
func (n Nullable[T]) Get() (T, bool) {
	return n.value, n.state == nullablePresent
}

// IsNull reports whether the Nullable sends null.
func (n Nullable[T]) IsNull() bool {
	return n.state == nullableNull
}

// IsZero reports whether the Nullable leaves the setting out of the request.
func (n Nullable[T]) IsZero() bool {
	return n.state == nullableAbsent
}

// MarshalJSON writes null or the value.
func (n Nullable[T]) MarshalJSON() ([]byte, error) {
	if n.state != nullablePresent {
		return []byte("null"), nil
	}
	return json.Marshal(n.value)
}

// UnmarshalJSON reads null or a value.
func (n *Nullable[T]) UnmarshalJSON(data []byte) error {
	if jsonKindOf(data) == "null" {
		*n = Null[T]()
		return nil
	}
	var value T
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	*n = Value(value)
	return nil
}

// Ptr returns a pointer to value, which fills an optional field in one expression.
func Ptr[T any](value T) *T {
	return &value
}
