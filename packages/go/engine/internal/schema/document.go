package schema

import (
	"fmt"
	"reflect"
	"strconv"
	"strings"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

func ValidateDocument(document model.Document, parsed *Parsed, patternValueLimit int) error {
	if document == nil {
		return narsilerr.New(narsilerr.CodeDocValidationFailed, "Document must be a plain object", map[string]any{"received": "object"})
	}
	if patternValueLimit <= 0 {
		patternValueLimit = DefaultPatternValueLimit
	}
	if err := requireIDFieldKey(document); err != nil {
		return err
	}
	if err := AssertStorableDocument(document, parsed); err != nil {
		return err
	}
	return validateLevel(document, rootOf(parsed), patternValueLimit)
}

func rootOf(parsed *Parsed) *level {
	if parsed == nil || parsed.root == nil {
		return &level{}
	}
	return parsed.root
}

func validateLevel(document map[string]any, current *level, limit int) error {
	for _, entry := range current.entries {
		value := document[entry.name]
		if value == nil {
			continue
		}
		if entry.nested != nil {
			if !isStoredObject(value) {
				return narsilerr.New(narsilerr.CodeDocValidationFailed, fmt.Sprintf("Field %q expected an object", entry.path), map[string]any{"field": entry.path, "received": receivedKind(value)})
			}
			nested, isMap := value.(map[string]any)
			if !isMap {
				continue
			}
			if err := validateLevel(nested, entry.nested, limit); err != nil {
				return err
			}
			continue
		}
		if err := validateFieldValue(entry.path, value, entry.field, limit); err != nil {
			return err
		}
	}
	return nil
}

func requireIDFieldKey(document map[string]any) error {
	id, present := document[documentIDField]
	if !present {
		return nil
	}
	if text, isText := id.(string); isText && text != "" {
		return nil
	}
	holds := "a " + typeofStored(id)
	received := typeofStored(id)
	switch {
	case id == nil:
		holds, received = "null", "null"
	case id == "":
		holds = "an empty string"
	}
	return narsilerr.New(
		narsilerr.CodeDocValidationFailed,
		fmt.Sprintf("Field \"id\" holds %s, while the engine stores a document under its id field, so that field must hold a non-empty string", holds),
		map[string]any{"field": documentIDField, "received": received},
	)
}

func ValidateDocumentStrict(document model.Document, parsed *Parsed) error {
	var extras []string
	collectExtraFields(document, rootOf(parsed), "", &extras)
	if len(extras) == 0 {
		return nil
	}
	return narsilerr.New(
		narsilerr.CodeDocValidationFailed,
		"Document contains fields not defined in schema: "+strings.Join(extras, ", "),
		map[string]any{"extraFields": extras},
	)
}

func collectExtraFields(document map[string]any, current *level, prefix string, extras *[]string) {
	for _, key := range sortedKeys(document) {
		if key == documentIDField {
			continue
		}
		path := joinPath(prefix, key)
		entry, declared := current.lookup(key)
		if !declared {
			*extras = append(*extras, path)
			continue
		}
		if nested, isMap := document[key].(map[string]any); isMap && entry.nested != nil {
			collectExtraFields(nested, entry.nested, path, extras)
		}
	}
}

func ValidateRequiredFields(document model.Document, required []string) error {
	for _, field := range required {
		if isMissing(resolveNestedValue(document, field)) {
			return narsilerr.New(narsilerr.CodeDocMissingRequiredField, fmt.Sprintf("Document is missing required field %q", field), map[string]any{"field": field})
		}
	}
	return nil
}

func isMissing(value any) bool {
	if value == nil {
		return true
	}
	reflected := reflect.ValueOf(value)
	switch reflected.Kind() {
	case reflect.Map, reflect.Slice, reflect.Pointer, reflect.Interface, reflect.Func, reflect.Chan:
		return reflected.IsNil()
	default:
		return false
	}
}

func resolveNestedValue(document model.Document, path string) any {
	if !strings.Contains(path, ".") {
		return document[path]
	}
	var current any = document
	for _, segment := range strings.Split(path, ".") {
		next, found := propertyOf(current, segment)
		if !found {
			return nil
		}
		current = next
	}
	return current
}

func propertyOf(container any, segment string) (any, bool) {
	switch typed := container.(type) {
	case nil:
		return nil, false
	case map[string]any:
		value, found := typed[segment]
		return value, found
	case []any:
		position, isIndex := listIndex(segment, len(typed))
		if !isIndex {
			return nil, false
		}
		return typed[position], true
	}
	reflected := reflect.ValueOf(container)
	switch reflected.Kind() {
	case reflect.Map:
		if reflected.IsNil() || reflected.Type().Key().Kind() != reflect.String {
			return nil, false
		}
		value := reflected.MapIndex(reflect.ValueOf(segment).Convert(reflected.Type().Key()))
		if !value.IsValid() {
			return nil, false
		}
		return value.Interface(), true
	case reflect.Slice, reflect.Array:
		position, isIndex := listIndex(segment, reflected.Len())
		if !isIndex {
			return nil, false
		}
		return reflected.Index(position).Interface(), true
	default:
		return nil, false
	}
}

func listIndex(segment string, length int) (int, bool) {
	position, err := strconv.Atoi(segment)
	if err != nil || position < 0 || position >= length || strconv.Itoa(position) != segment {
		return 0, false
	}
	return position, true
}
