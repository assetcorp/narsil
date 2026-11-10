package engine_test

import (
	"math"
	"strings"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	parityLongestID            = 512
	parityLargestDocumentBytes = 16_777_216
	parityDeepestDocument      = 32
)

func tsParityBaseSchema() map[string]any {
	return map[string]any{"title": "string", "body": "string", "rank": "number", "tags": "string[]",
		"place": "geopoint", "embedding": "vector[3]", "meta": map[string]any{"author": "string"}}
}

func parityBaseSchema() engine.Schema {
	return engine.Schema{"title": engine.FieldString, "body": engine.FieldString, "rank": engine.FieldNumber,
		"tags": engine.FieldStringList, "place": engine.FieldGeopoint, "embedding": engine.VectorFieldType(3),
		"meta": engine.Schema{"author": engine.FieldString}}
}

func tsParityBaseIndex() map[string]any {
	return map[string]any{"schema": tsParityBaseSchema()}
}

func parityBaseIndex() engine.IndexConfig {
	return engine.IndexConfig{Schema: parityBaseSchema()}
}

func parityBaseDocumentList() []map[string]any {
	return []map[string]any{
		{"id": "one", "title": "olive oil", "body": "cold pressed olive oil", "rank": 1.0, "tags": []any{"kitchen"},
			"place": map[string]any{"lat": 51.5, "lon": -0.12}, "embedding": []any{1.0, 0.0, 0.0}, "meta": map[string]any{"author": "casey"}},
		{"id": "two", "title": "sea salt", "body": "flaked sea salt", "rank": 2.0, "tags": []any{"pantry"},
			"place": map[string]any{"lat": 48.85, "lon": 2.35}, "embedding": []any{0.0, 1.0, 0.0}, "meta": map[string]any{"author": "robin"}},
	}
}

func nestedDocumentValue(depth int) any {
	var value any = "bottom"
	for range depth {
		value = map[string]any{"inner": value}
	}
	return value
}

func parityDocumentCases() []parityCase {
	strictTS := map[string]any{"schema": tsParityBaseSchema(), "strict": true}
	strictGo := engine.IndexConfig{Schema: parityBaseSchema(), Strict: true}
	requiredTS := map[string]any{"schema": tsParityBaseSchema(), "required": []any{"title"}}
	requiredGo := engine.IndexConfig{Schema: parityBaseSchema(), Required: []string{"title"}}
	return []parityCase{
		insertCase("a number in a string field", "", map[string]any{"title": 42.0}),
		insertCase("a string in a number field", "", map[string]any{"rank": "high"}),
		insertCase("NaN in a number field", "", map[string]any{"rank": math.NaN()}),
		insertCase("Infinity in a number field", "", map[string]any{"rank": math.Inf(1)}),
		insertCase("a boolean in a number field", "", map[string]any{"rank": true}),
		insertCase("a string in a string list", "", map[string]any{"tags": "kitchen"}),
		insertCase("numbers in a string list", "", map[string]any{"tags": []any{1.0, 2.0}}),
		insertCase("a vector one component short", "", map[string]any{"embedding": []any{1.0, 0.0}}),
		insertCase("a vector one component long", "", map[string]any{"embedding": []any{1.0, 0.0, 0.0, 0.0}}),
		insertCase("NaN inside a vector", "", map[string]any{"embedding": []any{1.0, math.NaN(), 0.0}}),
		insertCase("Infinity inside a vector", "", map[string]any{"embedding": []any{1.0, math.Inf(-1), 0.0}}),
		insertCase("a string inside a vector", "", map[string]any{"embedding": []any{1.0, "x", 0.0}}),
		insertCase("a string as a vector", "", map[string]any{"embedding": "1,0,0"}),
		insertCase("a latitude past the pole", "", map[string]any{"place": map[string]any{"lat": 91.0, "lon": 0.0}}),
		insertCase("a longitude past the date line", "", map[string]any{"place": map[string]any{"lat": 0.0, "lon": 181.0}}),
		insertCase("a word as a latitude", "", map[string]any{"place": map[string]any{"lat": "north", "lon": 0.0}}),
		insertCase("a geopoint missing its longitude", "", map[string]any{"place": map[string]any{"lat": 1.0}}),
		insertCase("a string in a nested object", "", map[string]any{"meta": "casey"}),
		insertCase("an ID one character too long", strings.Repeat("x", parityLongestID+1), map[string]any{"title": "long"}),
		insertCase("an ID in the document one character too long", "", map[string]any{"id": strings.Repeat("y", parityLongestID+1)}),
		insertCase("a number as the ID in the document", "", map[string]any{"id": 7.0, "title": "seven"}),
		insertCase("a document past the size limit", "", map[string]any{"body": strings.Repeat("a", parityLargestDocumentBytes)}),
		insertCase("a document nested past the depth limit", "", map[string]any{"extra": nestedDocumentValue(parityDeepestDocument + 1)}),
		insertCase("an ID that already exists", "one", map[string]any{"title": "again"}),
		insertCase("an ID in the document that already exists", "", map[string]any{"id": "two", "title": "again"}),
		insertCase("a field the strict schema leaves out", "", map[string]any{"title": "strict", "colour": "red"}).on(strictTS, strictGo),
		insertCase("a required field left out", "", map[string]any{"body": "no title"}).on(requiredTS, requiredGo),
		insertCase("a required field set to null", "", map[string]any{"title": nil}).on(requiredTS, requiredGo),
		batchCase("a batch whose second document has a bad number", []map[string]any{{"id": "b1", "title": "fine"},
			{"id": "b2", "rank": "bad"}}),
		batchCase("a batch that repeats an ID", []map[string]any{{"id": "b3", "title": "first"}, {"id": "b3", "title": "second"}}),
		updateCase("an update of a missing document", "missing", map[string]any{"title": "ghost"}),
		updateCase("an update with a bad vector", "one", map[string]any{"embedding": []any{1.0}}),
		updateCase("an update with a bad number", "one", map[string]any{"rank": math.NaN()}),
		updateCase("an update with an ID one character too long", strings.Repeat("z", parityLongestID+1), map[string]any{"title": "z"}),
	}
}
