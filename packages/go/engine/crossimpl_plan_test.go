package engine_test

import (
	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	crossIndexName          = "bills"
	crossDocumentCount      = 1_500
	crossInsertedLater      = 20
	crossUpdateStride       = 37
	crossRemoveStride       = 53
	crossVectorThreshold    = 256
	crossHitLimit           = 10
	crossVectorQueriesTaken = 40
	crossMaxPartitions      = 3
	crossDocsPerPartition   = 600
)

type crossScenario struct {
	name          string
	textStorage   engine.TextStorage
	vectorStorage engine.VectorStorageMode
	quantization  engine.VectorQuantizationMode
	partitioned   bool
}

func crossScenarios() []crossScenario {
	return []crossScenario{
		{name: "text and vectors in memory without quantisation", textStorage: engine.TextStorageMemory,
			vectorStorage: engine.VectorStorageMemory, quantization: engine.QuantizationNone, partitioned: true},
		{name: "text and vectors on disk quantised at 8 bits", textStorage: engine.TextStorageDisk,
			vectorStorage: engine.VectorStorageDisk, quantization: engine.QuantizationOSQ8},
		{name: "text and vectors in memory quantised at 2 bits", textStorage: engine.TextStorageMemory,
			vectorStorage: engine.VectorStorageMemory, quantization: engine.QuantizationOSQ2},
		{name: "text on disk and vectors in memory quantised at 1 bit", textStorage: engine.TextStorageDisk,
			vectorStorage: engine.VectorStorageMemory, quantization: engine.QuantizationOSQ1},
	}
}

func crossSchema() map[string]string {
	return map[string]string{"title": "string", "summary": "string", "embedding": "vector[384]"}
}

func (scenario crossScenario) typeScriptConfig() map[string]any {
	config := map[string]any{
		"schema":      crossSchema(),
		"language":    "english",
		"textStorage": string(scenario.textStorage),
		"vectorPromotion": map[string]any{"threshold": crossVectorThreshold, "quantization": string(scenario.quantization),
			"storage": string(scenario.vectorStorage)},
	}
	if scenario.partitioned {
		config["partitions"] = map[string]any{"maxPartitions": crossMaxPartitions, "maxDocsPerPartition": crossDocsPerPartition}
	}
	return config
}

func (scenario crossScenario) goConfig() engine.IndexConfig {
	schema := engine.Schema{}
	for field, fieldType := range crossSchema() {
		schema[field] = engine.FieldType(fieldType)
	}
	config := engine.IndexConfig{Schema: schema, Language: "english", TextStorage: scenario.textStorage,
		VectorPromotion: &engine.VectorIndexConfig{Threshold: engine.Some(crossVectorThreshold),
			Quantization: scenario.quantization, Storage: scenario.vectorStorage}}
	if scenario.partitioned {
		config.Partitions = engine.PartitionConfig{MaxPartitions: engine.Some(crossMaxPartitions), MaxDocsPerPartition: engine.Some(crossDocsPerPartition)}
	}
	return config
}

type crossDocument struct {
	Title     string    `json:"title"`
	Summary   string    `json:"summary"`
	Embedding []float32 `json:"embedding"`
}

type crossOperation struct {
	Op       string         `json:"op"`
	ID       string         `json:"id,omitempty"`
	Document map[string]any `json:"document,omitempty"`
}

type crossQuery struct {
	Term   string         `json:"term,omitempty"`
	Mode   string         `json:"mode,omitempty"`
	Limit  int            `json:"limit"`
	Vector map[string]any `json:"vector,omitempty"`
}

type crossPlan struct {
	Index     string           `json:"index"`
	Config    map[string]any   `json:"config"`
	Documents []map[string]any `json:"documents"`
	Later     []crossOperation `json:"later"`
	Queries   []crossQuery     `json:"queries"`

	saved map[string]crossDocument
	final map[string]crossDocument
}

func billRecord(dataset conformanceDataset, row int) (string, crossDocument) {
	bill := dataset.documents[row]
	return bill.ID, crossDocument{Title: bill.Title, Summary: bill.Summary,
		Embedding: dataset.vectors[row*datasetVectorDimension : (row+1)*datasetVectorDimension]}
}

func (document crossDocument) fields(id string) map[string]any {
	fields := map[string]any{"title": document.Title, "summary": document.Summary, "embedding": document.Embedding}
	if id != "" {
		fields["id"] = id
	}
	return fields
}

func buildCrossPlan(dataset conformanceDataset, scenario crossScenario) crossPlan {
	plan := crossPlan{Index: crossIndexName, Config: scenario.typeScriptConfig(), saved: map[string]crossDocument{},
		final: map[string]crossDocument{}}
	ids := make([]string, 0, crossDocumentCount)
	for row := range crossDocumentCount {
		id, document := billRecord(dataset, row)
		ids = append(ids, id)
		plan.saved[id] = document
		plan.final[id] = document
		plan.Documents = append(plan.Documents, document.fields(id))
	}
	for position, id := range ids {
		switch {
		case position%crossRemoveStride == 7:
			plan.Later = append(plan.Later, crossOperation{Op: "remove", ID: id})
			delete(plan.final, id)
		case position%crossUpdateStride == 3:
			_, donor := billRecord(dataset, (position*7+11)%crossDocumentCount)
			revised := crossDocument{Title: "revised " + plan.saved[id].Title, Summary: donor.Summary, Embedding: donor.Embedding}
			plan.Later = append(plan.Later, crossOperation{Op: "update", ID: id, Document: revised.fields("")})
			plan.final[id] = revised
		}
	}
	for row := crossDocumentCount; row < crossDocumentCount+crossInsertedLater; row++ {
		id, document := billRecord(dataset, row)
		plan.Later = append(plan.Later, crossOperation{Op: "insert", Document: document.fields(id)})
		plan.final[id] = document
	}
	for _, query := range dataset.queries.TextQueries {
		plan.Queries = append(plan.Queries, crossQuery{Term: query.Text, Limit: crossHitLimit})
	}
	for _, query := range dataset.queries.VectorQueries[:crossVectorQueriesTaken] {
		plan.Queries = append(plan.Queries, crossQuery{Mode: "vector", Limit: crossHitLimit,
			Vector: map[string]any{"field": "embedding", "value": query.Vector}})
	}
	return plan
}

func (query crossQuery) goParams() engine.QueryParams {
	params := engine.QueryParams{Term: query.Term, Limit: engine.Some(query.Limit), IncludeScores: true}
	if query.Mode != "vector" {
		return params
	}
	raw, _ := query.Vector["value"].([]float64)
	value := make([]float32, len(raw))
	for component, number := range raw {
		value[component] = float32(number)
	}
	params.Mode = engine.SearchVector
	params.Vector = &engine.VectorQueryConfig{Field: "embedding", Value: value}
	return params
}
