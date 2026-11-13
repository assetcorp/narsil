package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strconv"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	indexName    = "bench"
	vectorField  = "embedding"
	memorySettle = 200 * time.Millisecond
	usage        = "usage: narsil-engine-languages-go-runner <workload-dir> <keyword|vector> <threads> <output-file>"
	keywordKind  = "keyword"
	vectorKind   = "vector"
	runnerEngine = "go"
)

type arguments struct {
	workload string
	kind     string
	threads  int
	output   string
}

type runnerLoad struct {
	Documents  int   `json:"documents"`
	InsertNs   int64 `json:"insertNs"`
	OptimizeNs int64 `json:"optimizeNs"`
	ReadyNs    int64 `json:"readyNs"`
}

type runnerOutput struct {
	Engine       string                      `json:"engine"`
	Workload     string                      `json:"workload"`
	Threads      int                         `json:"threads"`
	Load         runnerLoad                  `json:"load"`
	Verification map[string][]verifiedAnswer `json:"verification"`
	Phases       map[string]measuredPhase    `json:"phases"`
}

func parseArguments(values []string) (arguments, error) {
	if len(values) != 4 || (values[1] != keywordKind && values[1] != vectorKind) {
		return arguments{}, errors.New(usage)
	}
	threads, err := strconv.Atoi(values[2])
	if err != nil || threads < 1 {
		return arguments{}, errors.New("threads must be a whole number of at least 1")
	}
	return arguments{workload: values[0], kind: values[1], threads: threads, output: values[3]}, nil
}

func openEngine(ctx context.Context, threads int) (*engine.Narsil, error) {
	workers := engine.WorkerConfig{Enabled: engine.Some(false)}
	if threads > 1 {
		workers = engine.WorkerConfig{Enabled: engine.Some(true), Count: engine.Some(threads)}
	}
	return engine.New(ctx, engine.Config{Workers: workers})
}

func createIndex(ctx context.Context, narsil *engine.Narsil, kind string, plan manifest) error {
	s := plan.Settings
	config := engine.IndexConfig{
		Schema:   engine.Schema{"title": engine.FieldString, "body": engine.FieldString},
		Language: s.Language,
	}
	if kind == vectorKind {
		config.Schema[vectorField] = engine.VectorFieldType(plan.Vector.Dimension)
		config.VectorPromotion = &engine.VectorIndexConfig{
			Threshold: engine.Some(s.VectorThreshold),
			HNSW: &engine.HNSWConfig{
				M:              engine.Some(s.HnswM),
				EfConstruction: engine.Some(s.HnswEfConstruction),
				Metric:         engine.MetricCosine,
			},
			Quantization: engine.QuantizationNone,
		}
	}
	return narsil.CreateIndex(ctx, indexName, config)
}

func loadDocuments(directory string, kind string, plan manifest) ([]*engine.Document, error) {
	if kind == keywordKind {
		rows, err := readTextDocuments(filepath.Join(directory, keywordDocumentsFile))
		if err != nil {
			return nil, err
		}
		documents := make([]*engine.Document, len(rows))
		for index, row := range rows {
			documents[index] = engine.DocumentFromMap(map[string]any{"id": row.ID, "title": row.Title, "body": row.Body})
		}
		return documents, nil
	}
	rows, err := readTextDocuments(filepath.Join(directory, vectorDocumentsFile))
	if err != nil {
		return nil, err
	}
	vectors, err := readVectors(filepath.Join(directory, vectorDocumentVectorsFile), plan.Vector.Documents, plan.Vector.Dimension)
	if err != nil {
		return nil, err
	}
	if len(rows) != len(vectors) {
		return nil, fmt.Errorf("%d documents carry %d vectors", len(rows), len(vectors))
	}
	documents := make([]*engine.Document, len(rows))
	for index, row := range rows {
		documents[index] = engine.DocumentFromMap(map[string]any{
			"id": row.ID, "title": row.Title, "body": row.Body, vectorField: vectors[index],
		})
	}
	return documents, nil
}

func batchesOf(documents []*engine.Document, size int) [][]*engine.Document {
	batches := [][]*engine.Document{}
	for start := 0; start < len(documents); start += size {
		batches = append(batches, documents[start:min(start+size, len(documents))])
	}
	return batches
}

func insertAll(ctx context.Context, narsil *engine.Narsil, batches [][]*engine.Document, threads int) error {
	return inParallel(threads, len(batches), func(item int) error {
		result, err := narsil.InsertBatch(ctx, indexName, batches[item], engine.InsertOptions{SkipClone: true})
		if err != nil {
			return err
		}
		if len(result.Failed) > 0 {
			return fmt.Errorf("batch %d refused %d documents: %v", item, len(result.Failed), result.Failed[0].Err)
		}
		return nil
	})
}

func querier(ctx context.Context, narsil *engine.Narsil, params []engine.QueryParams) search {
	return func(query int) (engine.QueryResult, error) {
		return narsil.Query(ctx, indexName, params[query])
	}
}

func runKeyword(ctx context.Context, narsil *engine.Narsil, directory string, plan manifest, threads int, out *runnerOutput) error {
	s := plan.Settings
	texts, err := readQueryTexts(filepath.Join(directory, keywordQueriesFile))
	if err != nil {
		return err
	}
	params := make([]engine.QueryParams, len(texts))
	for index, text := range texts {
		params[index] = engine.QueryParams{Term: text, Limit: engine.Some(s.Limit)}
	}
	run := querier(ctx, narsil, params)
	keyword, err := verifyEach(len(params), run)
	if err != nil {
		return err
	}
	phase, err := measurePhase(threads, s.WarmupPasses, s.MeasuredPasses.Keyword, keyword, run)
	if err != nil {
		return err
	}
	out.Verification["keyword"] = keyword
	out.Phases["keyword"] = phase
	return nil
}

func runVector(ctx context.Context, narsil *engine.Narsil, directory string, plan manifest, threads int, out *runnerOutput) error {
	s := plan.Settings
	texts, err := readQueryTexts(filepath.Join(directory, vectorQueriesFile))
	if err != nil {
		return err
	}
	vectors, err := readVectors(filepath.Join(directory, vectorQueryVectorsFile), plan.Vector.Queries, plan.Vector.Dimension)
	if err != nil {
		return err
	}
	if len(texts) != len(vectors) {
		return fmt.Errorf("%d vector queries carry %d vectors", len(texts), len(vectors))
	}
	clause := func(query int) *engine.VectorQueryConfig {
		return &engine.VectorQueryConfig{
			Field: vectorField, Value: vectors[query], Metric: engine.MetricCosine, EfSearch: engine.Some(s.EfSearch),
		}
	}
	vectorParams := func(limit int) []engine.QueryParams {
		params := make([]engine.QueryParams, len(vectors))
		for query := range params {
			params[query] = engine.QueryParams{Mode: engine.SearchVector, Vector: clause(query), Limit: engine.Some(limit)}
		}
		return params
	}
	hybrid := make([]engine.QueryParams, len(vectors))
	for query := range hybrid {
		hybrid[query] = engine.QueryParams{
			Mode:   engine.SearchHybrid,
			Term:   texts[query],
			Vector: clause(query),
			Hybrid: &engine.HybridConfig{Strategy: engine.HybridRRF, K: engine.Some(s.RrfK)},
			Limit:  engine.Some(s.Limit),
		}
	}
	textLeg := make([]engine.QueryParams, len(texts))
	for query := range textLeg {
		textLeg[query] = engine.QueryParams{Term: texts[query], Limit: engine.Some(s.HybridLegDepth)}
	}
	runTop := querier(ctx, narsil, vectorParams(s.Limit))
	runHybrid := querier(ctx, narsil, hybrid)
	checks := []struct {
		name string
		run  search
	}{
		{"vector", runTop},
		{"vectorLeg", querier(ctx, narsil, vectorParams(s.HybridLegDepth))},
		{"vectorDeep", querier(ctx, narsil, vectorParams(s.RecallDepth))},
		{"textLeg", querier(ctx, narsil, textLeg)},
		{"hybrid", runHybrid},
	}
	for _, check := range checks {
		if out.Verification[check.name], err = verifyEach(len(vectors), check.run); err != nil {
			return err
		}
	}
	if out.Phases["vector"], err = measurePhase(threads, s.WarmupPasses, s.MeasuredPasses.Vector, out.Verification["vector"], runTop); err != nil {
		return err
	}
	out.Phases["hybrid"], err = measurePhase(threads, s.WarmupPasses, s.MeasuredPasses.Hybrid, out.Verification["hybrid"], runHybrid)
	return err
}

func run(ctx context.Context, args arguments) error {
	plan, err := readManifest(args.workload)
	if err != nil {
		return err
	}
	narsil, err := openEngine(ctx, args.threads)
	if err != nil {
		return err
	}
	if err := createIndex(ctx, narsil, args.kind, plan); err != nil {
		return err
	}
	documents, err := loadDocuments(args.workload, args.kind, plan)
	if err != nil {
		return err
	}
	out := runnerOutput{
		Engine: runnerEngine, Workload: args.kind, Threads: args.threads,
		Verification: map[string][]verifiedAnswer{}, Phases: map[string]measuredPhase{},
	}
	out.Load.Documents = len(documents)
	insertStart := time.Now()
	if err := insertAll(ctx, narsil, batchesOf(documents, plan.Settings.InsertBatch), args.threads); err != nil {
		return err
	}
	out.Load.InsertNs = time.Since(insertStart).Nanoseconds()
	optimizeStart := time.Now()
	if args.kind == vectorKind {
		if err := narsil.OptimizeVectors(ctx, indexName, vectorField); err != nil {
			return err
		}
	}
	out.Load.OptimizeNs = time.Since(optimizeStart).Nanoseconds()

	runtime.GC()
	debug.FreeOSMemory()
	time.Sleep(memorySettle)
	if err := holdForMemoryReading(); err != nil {
		return err
	}

	if args.kind == keywordKind {
		err = runKeyword(ctx, narsil, args.workload, plan, args.threads, &out)
	} else {
		err = runVector(ctx, narsil, args.workload, plan, args.threads, &out)
	}
	if err != nil {
		return err
	}
	encoded, err := json.Marshal(out)
	if err != nil {
		return err
	}
	if err := os.WriteFile(args.output, encoded, 0o644); err != nil {
		return err
	}
	return narsil.Shutdown(ctx)
}

func main() {
	args, err := parseArguments(os.Args[1:])
	if err == nil {
		err = run(context.Background(), args)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
