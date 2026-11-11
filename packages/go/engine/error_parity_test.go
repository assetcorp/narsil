package engine_test

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	parityIndexName   = "cases"
	parityUntyped     = "UNTYPED"
	parityAccepted    = "OK"
	parityActionQuery = "query"
)

type parityCase struct {
	name      string
	action    string
	ts        map[string]any
	goEngine  engine.Config
	goIndex   *engine.IndexConfig
	tsIndex   map[string]any
	indexName string
	run       func(ctx context.Context, narsil *engine.Narsil) error
}

func (c parityCase) on(tsIndex map[string]any, goIndex engine.IndexConfig) parityCase {
	c.tsIndex = tsIndex
	c.goIndex = &goIndex
	return c
}

func engineCase(name string, tsConfig map[string]any, goConfig engine.Config) parityCase {
	return parityCase{name: name, action: "engine", ts: map[string]any{"config": tsConfig}, goEngine: goConfig}
}

func indexCase(name string, tsConfig map[string]any, goConfig engine.IndexConfig) parityCase {
	return parityCase{name: name, action: "createIndex", ts: map[string]any{"config": tsConfig}, goIndex: &goConfig,
		indexName: parityIndexName}
}

func indexNameCase(name string, indexName string) parityCase {
	goConfig := parityBaseIndex()
	return parityCase{name: name, action: "createIndex", ts: map[string]any{"config": tsParityBaseIndex(), "indexName": indexName},
		goIndex: &goConfig, indexName: indexName}
}

func documentsFromMaps(documents []map[string]any) []*engine.Document {
	built := make([]*engine.Document, len(documents))
	for at, document := range documents {
		built[at] = engine.DocumentFromMap(document)
	}
	return built
}

func insertCase(name string, id string, document map[string]any) parityCase {
	ts := map[string]any{"document": tsValue(document)}
	if id != "" {
		ts["id"] = id
	}
	return parityCase{name: name, action: "insert", ts: ts, run: func(ctx context.Context, narsil *engine.Narsil) error {
		_, err := narsil.Insert(ctx, parityIndexName, engine.DocumentFromMap(document), id, engine.InsertOptions{})
		return err
	}}
}

func batchCase(name string, documents []map[string]any) parityCase {
	encoded := make([]any, len(documents))
	for at, document := range documents {
		encoded[at] = tsValue(document)
	}
	return parityCase{name: name, action: "insertBatch", ts: map[string]any{"batch": encoded},
		run: func(ctx context.Context, narsil *engine.Narsil) error {
			result, err := narsil.InsertBatch(ctx, parityIndexName, documentsFromMaps(documents), engine.InsertOptions{})
			if err != nil {
				return err
			}
			if len(result.Failed) > 0 {
				return result.Failed[0].Err
			}
			return nil
		}}
}

func updateCase(name string, id string, document map[string]any) parityCase {
	return parityCase{name: name, action: "update", ts: map[string]any{"id": id, "document": tsValue(document)},
		run: func(ctx context.Context, narsil *engine.Narsil) error {
			return narsil.Update(ctx, parityIndexName, id, engine.DocumentFromMap(document), engine.WriteOptions{})
		}}
}

func queryCase(name string, tsQuery map[string]any, goQuery engine.QueryParams) parityCase {
	return parityCase{name: name, action: parityActionQuery, ts: map[string]any{"query": tsValue(tsQuery)},
		run: func(ctx context.Context, narsil *engine.Narsil) error {
			_, err := narsil.Query(ctx, parityIndexName, goQuery)
			return err
		}}
}

func preflightCase(name string, tsQuery map[string]any, goQuery engine.QueryParams) parityCase {
	return parityCase{name: name, action: "preflight", ts: map[string]any{"query": tsValue(tsQuery)},
		run: func(ctx context.Context, narsil *engine.Narsil) error {
			_, err := narsil.Preflight(ctx, parityIndexName, goQuery)
			return err
		}}
}

func suggestCase(name string, tsSuggest map[string]any, goSuggest engine.SuggestParams) parityCase {
	return parityCase{name: name, action: "suggest", ts: map[string]any{"suggest": tsSuggest},
		run: func(ctx context.Context, narsil *engine.Narsil) error {
			_, err := narsil.Suggest(ctx, parityIndexName, goSuggest)
			return err
		}}
}

func tsNumber(number float64) any {
	switch {
	case math.IsNaN(number):
		return map[string]any{"$number": "NaN"}
	case math.IsInf(number, 1):
		return map[string]any{"$number": "Infinity"}
	case math.IsInf(number, -1):
		return map[string]any{"$number": "-Infinity"}
	}
	return number
}

func tsValue(value any) any {
	switch typed := value.(type) {
	case float64:
		return tsNumber(typed)
	case float32:
		return tsNumber(float64(typed))
	case map[string]any:
		encoded := make(map[string]any, len(typed))
		for key, entry := range typed {
			encoded[key] = tsValue(entry)
		}
		return encoded
	case []any:
		encoded := make([]any, len(typed))
		for at, entry := range typed {
			encoded[at] = tsValue(entry)
		}
		return encoded
	case []float64:
		encoded := make([]any, len(typed))
		for at, entry := range typed {
			encoded[at] = tsNumber(entry)
		}
		return encoded
	case []float32:
		encoded := make([]any, len(typed))
		for at, entry := range typed {
			encoded[at] = tsNumber(float64(entry))
		}
		return encoded
	}
	return value
}

func (c parityCase) tsEntry() map[string]any {
	entry := map[string]any{"name": c.name, "action": c.action}
	for key, value := range c.ts {
		entry[key] = value
	}
	if c.action != "engine" && c.action != "createIndex" {
		entry["index"] = c.tsIndex
		if c.tsIndex == nil {
			entry["index"] = tsParityBaseIndex()
		}
		entry["documents"] = tsValue(parityBaseDocumentList())
	}
	return entry
}

func goOutcome(err error) string {
	if err == nil {
		return parityAccepted
	}
	if code := engine.ErrorCode(err); code != "" {
		return code
	}
	return parityUntyped + ": " + err.Error()
}

func (c parityCase) goOutcome(ctx context.Context) string {
	if c.action == "engine" {
		narsil, err := engine.New(ctx, c.goEngine)
		if err != nil {
			return goOutcome(err)
		}
		return goOutcome(narsil.Shutdown(ctx))
	}
	narsil, err := engine.New(ctx, engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)}})
	if err != nil {
		return "the engine refused to start: " + goOutcome(err)
	}
	defer func() { _ = narsil.Shutdown(ctx) }()
	index := parityBaseIndex()
	if c.goIndex != nil {
		index = *c.goIndex
	}
	if c.action == "createIndex" {
		return goOutcome(narsil.CreateIndex(ctx, c.indexName, index))
	}
	if err := narsil.CreateIndex(ctx, parityIndexName, index); err != nil {
		return "the case index was refused: " + goOutcome(err)
	}
	result, err := narsil.InsertBatch(ctx, parityIndexName, documentsFromMaps(parityBaseDocumentList()), engine.InsertOptions{})
	if err != nil || len(result.Failed) > 0 {
		return "the case documents were refused: " + goOutcome(err)
	}
	return goOutcome(c.run(ctx, narsil))
}

func TestErrorCodesMatchTheTypeScriptEngine(t *testing.T) {
	scratch := t.TempDir()
	var cases []parityCase
	cases = append(cases, parityDocumentCases()...)
	cases = append(cases, parityQueryCases()...)
	cases = append(cases, paritySettingCases(scratch)...)
	entries := make([]map[string]any, len(cases))
	seen := map[string]bool{}
	for at, entry := range cases {
		if seen[entry.name] {
			t.Fatalf("two cases share the name %q", entry.name)
		}
		seen[entry.name] = true
		entries[at] = entry.tsEntry()
	}
	casesPath := filepath.Join(scratch, "cases.json")
	outputPath := filepath.Join(scratch, "outcomes.json")
	writeJSONFile(t, casesPath, entries)
	runTypeScriptEngine(t, map[string]any{"mode": "errors", "cases": casesPath, "output": outputPath})
	data, err := os.ReadFile(outputPath)
	if err != nil {
		t.Fatalf("reading the TypeScript outcomes failed: %v", err)
	}
	tsOutcomes := map[string]string{}
	if err := json.Unmarshal(data, &tsOutcomes); err != nil {
		t.Fatalf("decoding the TypeScript outcomes failed: %v", err)
	}
	ctx := context.Background()
	refused := map[string]int{}
	for _, entry := range cases {
		tsOutcome, held := tsOutcomes[entry.name]
		goResult := entry.goOutcome(ctx)
		if goResult == tsOutcome && goResult != parityAccepted {
			refused[goResult]++
		}
		switch {
		case !held:
			t.Errorf("%s: the TypeScript engine reported no outcome", entry.name)
		case strings.HasPrefix(tsOutcome, parityUntyped):
			t.Errorf("%s: the TypeScript engine threw an untyped error (%s), while Go gave %s", entry.name, tsOutcome, goResult)
		case goResult != tsOutcome:
			t.Errorf("%s: Go gave %s, while the TypeScript engine gave %s", entry.name, goResult, tsOutcome)
		}
	}
	t.Logf("both engines refused these cases with the same code: %v", refused)
}
