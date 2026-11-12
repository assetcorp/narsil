package engine_test

import (
	"path/filepath"
	"strconv"
	"strings"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	parityWorkerCopyLimit   = 64
	parityIndexNameLimit    = 255
	parityVectorLimit       = 4_096
	paritySchemaDepthLimit  = 4
	parityPatternValueLimit = 65_536
	parityBM25BLimit        = 1
)

type parityDirectories struct {
	scratch string
	count   int
}

func (d *parityDirectories) next() (string, string) {
	d.count++
	name := strconv.Itoa(d.count)
	return filepath.Join(d.scratch, "ts-engines", name), filepath.Join(d.scratch, "go-engines", name)
}

func durabilityCase(directories *parityDirectories, name string, ts map[string]any, change func(*engine.DurabilityConfig)) parityCase {
	tsDirectory, goDirectory := directories.next()
	tsDurability := map[string]any{"directory": tsDirectory}
	for key, value := range ts {
		tsDurability[key] = value
	}
	goDurability := &engine.DurabilityConfig{Directory: goDirectory}
	change(goDurability)
	return engineCase(name, map[string]any{"durability": tsDurability, "workers": map[string]any{"enabled": false}},
		engine.Config{Durability: goDurability, Workers: engine.WorkerConfig{Enabled: engine.Some(false)}})
}

func workerCase(name string, ts map[string]any, goWorkers engine.WorkerConfig) parityCase {
	return engineCase(name, map[string]any{"workers": ts}, engine.Config{Workers: goWorkers})
}

func schemaCase(name string, tsSchema map[string]any, goSchema engine.Schema) parityCase {
	return indexCase(name, map[string]any{"schema": tsSchema}, engine.IndexConfig{Schema: goSchema})
}

func baseIndexWith(name string, ts map[string]any, change func(*engine.IndexConfig)) parityCase {
	tsIndex := tsParityBaseIndex()
	for key, value := range ts {
		tsIndex[key] = value
	}
	goIndex := parityBaseIndex()
	change(&goIndex)
	return indexCase(name, tsIndex, goIndex)
}

func parityDeepSchema(depth int) (map[string]any, engine.Schema) {
	ts := map[string]any{"leaf": "string"}
	goSchema := engine.Schema{"leaf": engine.FieldString}
	for range depth - 1 {
		ts = map[string]any{"inner": ts}
		goSchema = engine.Schema{"inner": goSchema}
	}
	return ts, goSchema
}

func paritySettingCases(scratch string) []parityCase {
	directories := &parityDirectories{scratch: scratch}
	deepTS, deepGo := parityDeepSchema(paritySchemaDepthLimit + 1)
	vectorField := func(name string, dimension string) parityCase {
		return schemaCase(name, map[string]any{"embedding": "vector[" + dimension + "]"},
			engine.Schema{"embedding": engine.FieldType("vector[" + dimension + "]")})
	}
	return []parityCase{
		workerCase("a negative worker count", map[string]any{"count": -1.0}, engine.WorkerConfig{Count: engine.Some(-1)}),
		workerCase("one worker past the limit", map[string]any{"count": float64(parityWorkerCopyLimit + 1)},
			engine.WorkerConfig{Count: engine.Some(parityWorkerCopyLimit + 1)}),
		workerCase("a promotion threshold of zero", map[string]any{"promotionThreshold": 0.0},
			engine.WorkerConfig{PromotionThreshold: engine.Some(0)}),
		workerCase("an unknown main copy setting", map[string]any{"mainCopyQueries": "sometimes"},
			engine.WorkerConfig{MainCopyQueries: engine.MainCopyQueries("sometimes")}),
		durabilityCase(directories, "an unknown durability mode", map[string]any{"mode": "eventually"},
			func(d *engine.DurabilityConfig) { d.Mode = engine.DurabilityMode("eventually") }),
		durabilityCase(directories, "an unknown durability tier", map[string]any{"tier": "archive"},
			func(d *engine.DurabilityConfig) { d.Tier = engine.DurabilityTier("archive") }),
		durabilityCase(directories, "a compaction threshold of zero", map[string]any{"compactionThreshold": 0.0},
			func(d *engine.DurabilityConfig) { d.CompactionThreshold = engine.Some(0) }),
		durabilityCase(directories, "a rewrite budget of zero", map[string]any{"rewriteBytesPerCheckpoint": 0.0},
			func(d *engine.DurabilityConfig) { d.RewriteBytesPerCheckpoint = engine.Some(int64(0)) }),
		durabilityCase(directories, "a negative rewrite budget", map[string]any{"rewriteBytesPerCheckpoint": -1.0},
			func(d *engine.DurabilityConfig) { d.RewriteBytesPerCheckpoint = engine.Some(int64(-1)) }),
		durabilityCase(directories, "a checkpoint mutation threshold of zero", map[string]any{"checkpointMutationThreshold": 0.0},
			func(d *engine.DurabilityConfig) { d.CheckpointMutationThreshold = engine.Some(0) }),
		durabilityCase(directories, "a segment size of zero", map[string]any{"segmentMaxBytes": 0.0},
			func(d *engine.DurabilityConfig) { d.SegmentMaxBytes = engine.Some(int64(0)) }),
		durabilityCase(directories, "the snapshot tier without persistence", map[string]any{"tier": "snapshot"},
			func(d *engine.DurabilityConfig) { d.Tier = engine.DurabilitySnapshot }),
		engineCase("durability without a directory", map[string]any{"durability": map[string]any{"mode": "sync"}},
			engine.Config{Durability: &engine.DurabilityConfig{Mode: engine.DurabilitySync}}),
		indexNameCase("an empty index name", ""),
		indexNameCase("an index name one character too long", strings.Repeat("n", parityIndexNameLimit+1)),
		indexNameCase("an index name with a slash", "a/b"),
		indexNameCase("an index name of two dots", ".."),
		indexNameCase("an index name with a null character", "a\u0000b"),
		baseIndexWith("an unknown language", map[string]any{"language": "klingon"}, func(c *engine.IndexConfig) { c.Language = "klingon" }),
		baseIndexWith("disk text without durability", map[string]any{"textStorage": "disk"},
			func(c *engine.IndexConfig) { c.TextStorage = engine.TextStorageDisk }),
		baseIndexWith("an unknown text storage", map[string]any{"textStorage": "tape"},
			func(c *engine.IndexConfig) { c.TextStorage = engine.TextStorage("tape") }),
		baseIndexWith("disk vectors without durability", map[string]any{"vectorPromotion": map[string]any{"storage": "disk"}},
			func(c *engine.IndexConfig) {
				c.VectorPromotion = &engine.VectorIndexConfig{Storage: engine.VectorStorageDisk}
			}),
		baseIndexWith("an unknown quantization", map[string]any{"vectorPromotion": map[string]any{"quantization": "osq3"}},
			func(c *engine.IndexConfig) {
				c.VectorPromotion = &engine.VectorIndexConfig{Quantization: engine.VectorQuantizationMode("osq3")}
			}),
		baseIndexWith("a vector promotion threshold of zero", map[string]any{"vectorPromotion": map[string]any{"threshold": 0.0}},
			func(c *engine.IndexConfig) { c.VectorPromotion = &engine.VectorIndexConfig{Threshold: engine.Some(0)} }),
		baseIndexWith("an unknown distance metric", map[string]any{"vectorPromotion": map[string]any{"hnswConfig": map[string]any{"metric": "manhattan"}}},
			func(c *engine.IndexConfig) {
				c.VectorPromotion = &engine.VectorIndexConfig{HNSW: &engine.HNSWConfig{Metric: engine.VectorMetric("manhattan")}}
			}),
		baseIndexWith("a graph degree of zero", map[string]any{"vectorPromotion": map[string]any{"hnswConfig": map[string]any{"m": 0.0}}},
			func(c *engine.IndexConfig) {
				c.VectorPromotion = &engine.VectorIndexConfig{HNSW: &engine.HNSWConfig{M: engine.Some(0)}}
			}),
		baseIndexWith("a pattern value limit of zero", map[string]any{"patternValueLimit": 0.0},
			func(c *engine.IndexConfig) { c.PatternValueLimit = engine.Some(0) }),
		baseIndexWith("a pattern value limit one past the limit", map[string]any{"patternValueLimit": float64(parityPatternValueLimit + 1)},
			func(c *engine.IndexConfig) { c.PatternValueLimit = engine.Some(parityPatternValueLimit + 1) }),
		baseIndexWith("an index k1 past the limit", map[string]any{"bm25": map[string]any{"k1": float64(parityBM25K1Limit + 1)}},
			func(c *engine.IndexConfig) {
				c.BM25 = engine.BM25Params{K1: engine.Some(float64(parityBM25K1Limit + 1))}
			}),
		baseIndexWith("an index b past one", map[string]any{"bm25": map[string]any{"b": float64(parityBM25BLimit) + 0.5}},
			func(c *engine.IndexConfig) {
				c.BM25 = engine.BM25Params{B: engine.Some(float64(parityBM25BLimit) + 0.5)}
			}),
		baseIndexWith("a field k1 on a number field", map[string]any{"bm25": map[string]any{"fields": map[string]any{"rank": map[string]any{"k1": 1.0}}}},
			func(c *engine.IndexConfig) {
				c.BM25 = engine.BM25Params{Fields: map[string]engine.BM25FieldParams{"rank": {K1: engine.Some(1.0)}}}
			}),
		baseIndexWith("a partition cap of zero", map[string]any{"partitions": map[string]any{"maxPartitions": 0.0}},
			func(c *engine.IndexConfig) { c.Partitions = engine.PartitionConfig{MaxPartitions: engine.Some(0)} }),
		baseIndexWith("a partition size of zero", map[string]any{"partitions": map[string]any{"maxDocsPerPartition": 0.0}},
			func(c *engine.IndexConfig) {
				c.Partitions = engine.PartitionConfig{MaxDocsPerPartition: engine.Some(0)}
			}),
		baseIndexWith("a required field missing from the schema", map[string]any{"required": []any{"colour"}},
			func(c *engine.IndexConfig) { c.Required = []string{"colour"} }),
		baseIndexWith("an unknown default scoring", map[string]any{"defaultScoring": "global"},
			func(c *engine.IndexConfig) { c.DefaultScoring = engine.ScoringMode("global") }),
		schemaCase("an unknown field type", map[string]any{"title": "text"}, engine.Schema{"title": engine.FieldType("text")}),
		schemaCase("an unknown text option", map[string]any{"title": "string:fuzzy"}, engine.Schema{"title": engine.FieldType("string:fuzzy")}),
		schemaCase("a schema nested past the depth limit", deepTS, deepGo),
		schemaCase("an empty schema", map[string]any{}, engine.Schema{}),
		schemaCase("a field name with a dot", map[string]any{"a.b": "string"}, engine.Schema{"a.b": engine.FieldString}),
		schemaCase("an empty field name", map[string]any{"": "string"}, engine.Schema{"": engine.FieldString}),
		vectorField("a vector of no dimensions", "0"),
		vectorField("a vector one dimension past the limit", strconv.Itoa(parityVectorLimit+1)),
		vectorField("a vector of negative dimensions", "-3"),
		vectorField("a vector of fractional dimensions", "1.5"),
		vectorField("a vector with a word for a dimension", "three"),
	}
}
