package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
)

const (
	manifestFile              = "manifest.json"
	keywordDocumentsFile      = "keyword-documents.jsonl"
	keywordQueriesFile        = "keyword-queries.jsonl"
	vectorDocumentsFile       = "vector-documents.jsonl"
	vectorDocumentVectorsFile = "vector-documents.f32"
	vectorQueriesFile         = "vector-queries.jsonl"
	vectorQueryVectorsFile    = "vector-queries.f32"
	float32Bytes              = 4
	longestJSONLineBytes      = 64 * 1024 * 1024
)

type measuredPasses struct {
	Keyword int `json:"keyword"`
	Vector  int `json:"vector"`
	Hybrid  int `json:"hybrid"`
}

type settings struct {
	Language                 string         `json:"language"`
	Limit                    int            `json:"limit"`
	RecallDepth              int            `json:"recallDepth"`
	HybridLegDepth           int            `json:"hybridLegDepth"`
	EfSearch                 int            `json:"efSearch"`
	HnswM                    int            `json:"hnswM"`
	HnswEfConstruction       int            `json:"hnswEfConstruction"`
	VectorThreshold          int            `json:"vectorThreshold"`
	RrfK                     int            `json:"rrfK"`
	InsertBatch              int            `json:"insertBatch"`
	WarmupPasses             int            `json:"warmupPasses"`
	WorkerPromotionThreshold int            `json:"workerPromotionThreshold"`
	MeasuredPasses           measuredPasses `json:"measuredPasses"`
}

type manifest struct {
	Vector struct {
		Dimension int `json:"dimension"`
		Documents int `json:"documents"`
		Queries   int `json:"queries"`
	} `json:"vector"`
	Settings settings `json:"settings"`
}

type textDocument struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Body  string `json:"body"`
}

type queryText struct {
	Text string `json:"text"`
}

func requirePositive(values map[string]int) error {
	for name, value := range values {
		if value < 1 {
			return fmt.Errorf("the manifest's %s must be a positive whole number", name)
		}
	}
	return nil
}

func readManifest(directory string) (manifest, error) {
	var parsed manifest
	raw, err := os.ReadFile(filepath.Join(directory, manifestFile))
	if err != nil {
		return parsed, err
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return parsed, fmt.Errorf("%s: %w", manifestFile, err)
	}
	s := parsed.Settings
	if s.Language == "" {
		return parsed, fmt.Errorf("the manifest's settings.language must be a non-empty string")
	}
	return parsed, requirePositive(map[string]int{
		"vector.dimension":                  parsed.Vector.Dimension,
		"vector.documents":                  parsed.Vector.Documents,
		"vector.queries":                    parsed.Vector.Queries,
		"settings.limit":                    s.Limit,
		"settings.recallDepth":              s.RecallDepth,
		"settings.hybridLegDepth":           s.HybridLegDepth,
		"settings.efSearch":                 s.EfSearch,
		"settings.hnswM":                    s.HnswM,
		"settings.hnswEfConstruction":       s.HnswEfConstruction,
		"settings.vectorThreshold":          s.VectorThreshold,
		"settings.rrfK":                     s.RrfK,
		"settings.insertBatch":              s.InsertBatch,
		"settings.warmupPasses":             s.WarmupPasses,
		"settings.workerPromotionThreshold": s.WorkerPromotionThreshold,
		"settings.measuredPasses.keyword":   s.MeasuredPasses.Keyword,
		"settings.measuredPasses.vector":    s.MeasuredPasses.Vector,
		"settings.measuredPasses.hybrid":    s.MeasuredPasses.Hybrid,
	})
}

func readJSONLines[Row any](path string, check func(Row) bool) ([]Row, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 1024*1024), longestJSONLineBytes)
	rows := []Row{}
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var row Row
		if err := json.Unmarshal(line, &row); err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
		if !check(row) {
			return nil, fmt.Errorf("%s: a line lacks a required string field", path)
		}
		rows = append(rows, row)
	}
	return rows, scanner.Err()
}

func readTextDocuments(path string) ([]textDocument, error) {
	return readJSONLines(path, func(row textDocument) bool { return row.ID != "" })
}

func readQueryTexts(path string) ([]string, error) {
	rows, err := readJSONLines(path, func(queryText) bool { return true })
	if err != nil {
		return nil, err
	}
	texts := make([]string, len(rows))
	for index, row := range rows {
		texts[index] = row.Text
	}
	return texts, nil
}

func readVectors(path string, rows int, dimension int) ([][]float32, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	expected := rows * dimension * float32Bytes
	if len(raw) != expected {
		return nil, fmt.Errorf("%s holds %d bytes, while %d vectors of %d take %d", path, len(raw), rows, dimension, expected)
	}
	vectors := make([][]float32, rows)
	for row := range vectors {
		vector := make([]float32, dimension)
		for component := range vector {
			offset := (row*dimension + component) * float32Bytes
			vector[component] = math.Float32frombits(binary.LittleEndian.Uint32(raw[offset : offset+float32Bytes]))
		}
		vectors[row] = vector
	}
	return vectors, nil
}
