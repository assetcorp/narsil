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

func parityBaseDocumentList() []engine.Document {
	return []engine.Document{
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
		insertCase("a number in a string field", "", engine.Document{"title": 42.0}),
		insertCase("a string in a number field", "", engine.Document{"rank": "high"}),
		insertCase("NaN in a number field", "", engine.Document{"rank": math.NaN()}),
		insertCase("Infinity in a number field", "", engine.Document{"rank": math.Inf(1)}),
		insertCase("a boolean in a number field", "", engine.Document{"rank": true}),
		insertCase("a string in a string list", "", engine.Document{"tags": "kitchen"}),
		insertCase("numbers in a string list", "", engine.Document{"tags": []any{1.0, 2.0}}),
		insertCase("a vector one component short", "", engine.Document{"embedding": []any{1.0, 0.0}}),
		insertCase("a vector one component long", "", engine.Document{"embedding": []any{1.0, 0.0, 0.0, 0.0}}),
		insertCase("NaN inside a vector", "", engine.Document{"embedding": []any{1.0, math.NaN(), 0.0}}),
		insertCase("Infinity inside a vector", "", engine.Document{"embedding": []any{1.0, math.Inf(-1), 0.0}}),
		insertCase("a string inside a vector", "", engine.Document{"embedding": []any{1.0, "x", 0.0}}),
		insertCase("a string as a vector", "", engine.Document{"embedding": "1,0,0"}),
		insertCase("a latitude past the pole", "", engine.Document{"place": map[string]any{"lat": 91.0, "lon": 0.0}}),
		insertCase("a longitude past the date line", "", engine.Document{"place": map[string]any{"lat": 0.0, "lon": 181.0}}),
		insertCase("a word as a latitude", "", engine.Document{"place": map[string]any{"lat": "north", "lon": 0.0}}),
		insertCase("a geopoint missing its longitude", "", engine.Document{"place": map[string]any{"lat": 1.0}}),
		insertCase("a string in a nested object", "", engine.Document{"meta": "casey"}),
		insertCase("an ID one character too long", strings.Repeat("x", parityLongestID+1), engine.Document{"title": "long"}),
		insertCase("an ID in the document one character too long", "", engine.Document{"id": strings.Repeat("y", parityLongestID+1)}),
		insertCase("a number as the ID in the document", "", engine.Document{"id": 7.0, "title": "seven"}),
		insertCase("a document past the size limit", "", engine.Document{"body": strings.Repeat("a", parityLargestDocumentBytes)}),
		insertCase("a document nested past the depth limit", "", engine.Document{"extra": nestedDocumentValue(parityDeepestDocument + 1)}),
		insertCase("an ID that already exists", "one", engine.Document{"title": "again"}),
		insertCase("an ID in the document that already exists", "", engine.Document{"id": "two", "title": "again"}),
		insertCase("a field the strict schema leaves out", "", engine.Document{"title": "strict", "colour": "red"}).on(strictTS, strictGo),
		insertCase("a required field left out", "", engine.Document{"body": "no title"}).on(requiredTS, requiredGo),
		insertCase("a required field set to null", "", engine.Document{"title": nil}).on(requiredTS, requiredGo),
		batchCase("a batch whose second document has a bad number", []engine.Document{{"id": "b1", "title": "fine"},
			{"id": "b2", "rank": "bad"}}),
		batchCase("a batch that repeats an ID", []engine.Document{{"id": "b3", "title": "first"}, {"id": "b3", "title": "second"}}),
		updateCase("an update of a missing document", "missing", engine.Document{"title": "ghost"}),
		updateCase("an update with a bad vector", "one", engine.Document{"embedding": []any{1.0}}),
		updateCase("an update with a bad number", "one", engine.Document{"rank": math.NaN()}),
		updateCase("an update with an ID one character too long", strings.Repeat("z", parityLongestID+1), engine.Document{"title": "z"}),
	}
}
