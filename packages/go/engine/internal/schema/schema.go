package schema

import (
	"fmt"
	"regexp"
	"sort"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

var fieldNamePattern = regexp.MustCompile(`^[A-Za-z0-9_]+$`)

var prototypePollutionKeys = map[string]bool{"__proto__": true, "constructor": true, "prototype": true}

const reservedRootField = "id"

type Field struct {
	Path string
	ParsedFieldType
}

type levelEntry struct {
	name   string
	path   string
	nested *level
	field  ParsedFieldType
}

type level struct {
	entries []levelEntry
	byName  map[string]int
}

func (l *level) lookup(name string) (levelEntry, bool) {
	position, found := l.byName[name]
	if !found {
		return levelEntry{}, false
	}
	return l.entries[position], true
}

type Parsed struct {
	schema  model.Schema
	root    *level
	fields  []Field
	byPath  map[string]Field
	vectors map[string]int
	partial []string
	order   []string
}

func (p *Parsed) Schema() model.Schema {
	return copySchema(p.schema)
}

func (p *Parsed) Fields() []Field {
	return append([]Field(nil), p.fields...)
}

func (p *Parsed) Field(path string) (Field, bool) {
	return p.declared(path)
}

func (p *Parsed) VectorFields() map[string]int {
	copied := make(map[string]int, len(p.vectors))
	for path, dimension := range p.vectors {
		copied[path] = dimension
	}
	return copied
}

func (p *Parsed) PartialFields() []string {
	return append([]string(nil), p.partial...)
}

func (p *Parsed) Flatten() map[string]model.FieldType {
	flat := make(map[string]model.FieldType, len(p.fields))
	for _, field := range p.fields {
		flat[field.Path] = field.Type
	}
	return flat
}

func Parse(definition model.Schema) (*Parsed, error) {
	if definition == nil {
		return nil, narsilerr.New(narsilerr.CodeSchemaInvalidType, "Schema must be a plain object", map[string]any{"received": "undefined"})
	}
	return FromValue(untypedSchema(definition, 1))
}

func FromValue(value any) (*Parsed, error) {
	root, isObject := schemaObject(value)
	if !isObject {
		return nil, narsilerr.New(narsilerr.CodeSchemaInvalidType, "Schema must be a plain object", map[string]any{"received": describeKind(value)})
	}
	if len(root) == 0 {
		return nil, narsilerr.New(narsilerr.CodeSchemaInvalidType, "Schema must define at least one field", nil)
	}
	parsed := &Parsed{byPath: map[string]Field{}, vectors: map[string]int{}}
	canonical, top, err := parseLevel(root, 1, "", parsed)
	if err != nil {
		return nil, err
	}
	if err := requireTextFieldCount(countTextFields(parsed.fields)); err != nil {
		return nil, err
	}
	parsed.schema = canonical
	parsed.root = top
	sort.Slice(parsed.fields, func(i, j int) bool { return parsed.fields[i].Path < parsed.fields[j].Path })
	sort.Strings(parsed.partial)
	return parsed, nil
}

func parseLevel(definition map[string]any, depth int, prefix string, parsed *Parsed) (model.Schema, *level, error) {
	if depth > MaxNestingDepth {
		return nil, nil, narsilerr.New(
			narsilerr.CodeSchemaDepthExceeded,
			fmt.Sprintf("Schema nesting exceeds the maximum depth of %d at %q", MaxNestingDepth, prefix),
			map[string]any{"path": prefix, "maxDepth": MaxNestingDepth},
		)
	}
	names := sortedKeys(definition)
	canonical := make(model.Schema, len(names))
	current := &level{byName: make(map[string]int, len(names))}
	for _, name := range names {
		path := joinPath(prefix, name)
		if err := requireFieldName(name, path, depth); err != nil {
			return nil, nil, err
		}
		entry := definition[name]
		if nestedDefinition, isObject := schemaObject(entry); isObject {
			nestedSchema, nestedLevel, err := parseLevel(nestedDefinition, depth+1, path, parsed)
			if err != nil {
				return nil, nil, err
			}
			canonical[name] = nestedSchema
			current.byName[name] = len(current.entries)
			current.entries = append(current.entries, levelEntry{name: name, path: path, nested: nestedLevel})
			continue
		}
		typeName, isText := schemaTypeName(entry)
		if !isText {
			written := describeValue(entry)
			return nil, nil, narsilerr.New(
				narsilerr.CodeSchemaInvalidType,
				fmt.Sprintf("Field %q has an invalid type definition: %s", path, written),
				map[string]any{"field": path, "type": written},
			)
		}
		fieldType, err := ParseFieldType(typeName, path)
		if err != nil {
			return nil, nil, err
		}
		canonical[name] = fieldType.Type
		current.byName[name] = len(current.entries)
		current.entries = append(current.entries, levelEntry{name: name, path: path, field: fieldType})
		recordField(parsed, Field{Path: path, ParsedFieldType: fieldType})
	}
	return canonical, current, nil
}

func recordField(parsed *Parsed, field Field) {
	parsed.fields = append(parsed.fields, field)
	parsed.byPath[field.Path] = field
	if field.Base == BaseVector {
		parsed.vectors[field.Path] = field.Dimension
	}
	if field.Partial {
		parsed.partial = append(parsed.partial, field.Path)
	}
}

func requireFieldName(name, path string, depth int) error {
	if prototypePollutionKeys[name] {
		return narsilerr.New(narsilerr.CodeSchemaInvalidType, fmt.Sprintf("Field name %q is not allowed in a schema", name), map[string]any{"field": name, "path": path})
	}
	if !fieldNamePattern.MatchString(name) {
		return narsilerr.New(
			narsilerr.CodeSchemaInvalidType,
			fmt.Sprintf("Field name %q contains characters that are not allowed; use letters, digits, and underscores only", name),
			map[string]any{"field": name, "path": path},
		)
	}
	if depth == 1 && name == reservedRootField {
		return narsilerr.New(narsilerr.CodeSchemaInvalidType, fmt.Sprintf("Field %q is reserved and cannot be defined in a schema", name), map[string]any{"field": name, "path": path})
	}
	return nil
}

func countTextFields(fields []Field) int {
	count := 0
	for _, field := range fields {
		if field.IsWordIndexed() {
			count++
		}
	}
	return count
}

func requireTextFieldCount(count int) error {
	if count <= MaxTextFields {
		return nil
	}
	return narsilerr.New(
		narsilerr.CodeSchemaInvalidType,
		fmt.Sprintf("The schema declares %d string and string[] fields, but a schema holds at most %d", count, MaxTextFields),
		map[string]any{"textFields": count, "maximum": MaxTextFields},
	)
}

func (p *Parsed) RequireCreatable() error {
	for _, field := range p.fields {
		if field.Base != BaseVector || field.Dimension <= MaxVectorDimension {
			continue
		}
		return narsilerr.New(
			narsilerr.CodeSchemaInvalidVectorDimension,
			fmt.Sprintf("Vector field %q has %d dimensions, but a new index takes at most %d", field.Path, field.Dimension, MaxVectorDimension),
			map[string]any{"field": field.Path, "dimension": field.Dimension, "maximum": MaxVectorDimension},
		)
	}
	return nil
}

func RequireValidFieldTypes(flat map[string]any) error {
	textFields := 0
	for _, path := range sortedKeys(flat) {
		typeName, isText := schemaTypeName(flat[path])
		if !isText {
			written := describeValue(flat[path])
			return narsilerr.New(
				narsilerr.CodeSchemaInvalidType,
				fmt.Sprintf("Field %q has an invalid type definition: %s", path, written),
				map[string]any{"field": path, "type": written},
			)
		}
		fieldType, err := ParseFieldType(typeName, path)
		if err != nil {
			return err
		}
		if fieldType.IsWordIndexed() {
			textFields++
		}
	}
	return requireTextFieldCount(textFields)
}

func joinPath(prefix, name string) string {
	if prefix == "" {
		return name
	}
	return prefix + "." + name
}

func sortedKeys[V any](values map[string]V) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
