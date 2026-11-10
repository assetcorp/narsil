package schema

import (
	"fmt"
	"reflect"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

func untypedSchema(definition model.Schema, depth int) map[string]any {
	untyped := make(map[string]any, len(definition))
	if depth > MaxNestingDepth {
		return untyped
	}
	for name, entry := range definition {
		switch typed := entry.(type) {
		case model.FieldType:
			untyped[name] = string(typed)
		case model.Schema:
			untyped[name] = untypedSchema(typed, depth+1)
		default:
			untyped[name] = entry
		}
	}
	return untyped
}

func schemaObject(value any) (map[string]any, bool) {
	switch typed := value.(type) {
	case map[string]any:
		if typed == nil {
			return map[string]any{}, true
		}
		return typed, true
	case model.Schema:
		return untypedSchema(typed, 1), true
	case map[string]string:
		converted := make(map[string]any, len(typed))
		for name, fieldType := range typed {
			converted[name] = fieldType
		}
		return converted, true
	default:
		return nil, false
	}
}

func schemaTypeName(value any) (string, bool) {
	switch typed := value.(type) {
	case string:
		return typed, true
	case model.FieldType:
		return string(typed), true
	default:
		return "", false
	}
}

func describeKind(value any) string {
	if value == nil {
		return "undefined"
	}
	switch reflect.ValueOf(value).Kind() {
	case reflect.String:
		return "string"
	case reflect.Bool:
		return "boolean"
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr,
		reflect.Float32, reflect.Float64:
		return "number"
	case reflect.Func:
		return "function"
	default:
		return "object"
	}
}

func describeValue(value any) string {
	if value == nil {
		return "null"
	}
	reflected := reflect.ValueOf(value)
	switch reflected.Kind() {
	case reflect.String, reflect.Bool,
		reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr,
		reflect.Float32, reflect.Float64:
		return fmt.Sprint(value)
	default:
		return "a value of type " + reflected.Type().String()
	}
}

func copySchema(definition model.Schema) model.Schema {
	copied := make(model.Schema, len(definition))
	for name, entry := range definition {
		if nested, isNested := entry.(model.Schema); isNested {
			copied[name] = copySchema(nested)
			continue
		}
		copied[name] = entry
	}
	return copied
}
