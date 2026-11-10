package model

import "strconv"

type Document = map[string]any

type FieldType string

const (
	FieldString       FieldType = "string"
	FieldStringList   FieldType = "string[]"
	FieldVerbatim     FieldType = "verbatim"
	FieldVerbatimList FieldType = "verbatim[]"
	FieldNumber       FieldType = "number"
	FieldNumberList   FieldType = "number[]"
	FieldBoolean      FieldType = "boolean"
	FieldBooleanList  FieldType = "boolean[]"
	FieldEnum         FieldType = "enum"
	FieldEnumList     FieldType = "enum[]"
	FieldGeopoint     FieldType = "geopoint"
)

type TextFieldOption string

const (
	TextFieldSortable TextFieldOption = "sortable"
	TextFieldPattern  TextFieldOption = "pattern"
	TextFieldPartial  TextFieldOption = "partial"
)

func VectorFieldType(dimension int) FieldType {
	return FieldType("vector[" + strconv.Itoa(dimension) + "]")
}

func (t FieldType) WithOptions(options ...TextFieldOption) FieldType {
	text := string(t)
	for _, option := range options {
		text += ":" + string(option)
	}
	return FieldType(text)
}

type SchemaEntry interface {
	schemaEntry()
}

func (FieldType) schemaEntry() {}

type Schema map[string]SchemaEntry

func (Schema) schemaEntry() {}

type ScoringMode string

const (
	ScoringLocal     ScoringMode = "local"
	ScoringDFS       ScoringMode = "dfs"
	ScoringBroadcast ScoringMode = "broadcast"
)

type TextStorage string

const (
	TextStorageMemory TextStorage = "memory"
	TextStorageDisk   TextStorage = "disk"
)

type VectorQuantizationMode string

const (
	QuantizationOSQ8 VectorQuantizationMode = "osq8"
	QuantizationOSQ4 VectorQuantizationMode = "osq4"
	QuantizationOSQ2 VectorQuantizationMode = "osq2"
	QuantizationOSQ1 VectorQuantizationMode = "osq1"
	QuantizationNone VectorQuantizationMode = "none"
)

type VectorStorageMode string

const (
	VectorStorageMemory VectorStorageMode = "memory"
	VectorStorageDisk   VectorStorageMode = "disk"
)

type VectorMetric string

const (
	MetricCosine     VectorMetric = "cosine"
	MetricDotProduct VectorMetric = "dotProduct"
	MetricEuclidean  VectorMetric = "euclidean"
)

type HNSWConfig struct {
	M              Optional[int]
	EfConstruction Optional[int]
	Metric         VectorMetric
}

type VectorIndexConfig struct {
	Threshold       Optional[int]
	FilterThreshold Optional[float64]
	HNSW            *HNSWConfig
	Quantization    VectorQuantizationMode
	Storage         VectorStorageMode
}

type PartitionConfig struct {
	MaxDocsPerPartition Optional[int]
	MaxPartitions       Optional[int]
	Watermark           Optional[float64]
}

type BM25FieldParams struct {
	K1 Optional[float64]
	B  Optional[float64]
}

type BM25Params struct {
	K1     Optional[float64]
	B      Optional[float64]
	Fields map[string]BM25FieldParams
}

type embeddingAdapterKind uint8

const (
	embeddingAdapterAbsent embeddingAdapterKind = iota
	embeddingAdapterInstance
	embeddingAdapterRegistered
)

type EmbeddingAdapterRef struct {
	kind     embeddingAdapterKind
	instance EmbeddingAdapter
	name     string
}

func EmbeddingAdapterInstance(adapter EmbeddingAdapter) EmbeddingAdapterRef {
	return EmbeddingAdapterRef{kind: embeddingAdapterInstance, instance: adapter}
}

func RegisteredEmbeddingAdapter(name string) EmbeddingAdapterRef {
	return EmbeddingAdapterRef{kind: embeddingAdapterRegistered, name: name}
}

func (r EmbeddingAdapterRef) IsSet() bool {
	return r.kind != embeddingAdapterAbsent
}

func (r EmbeddingAdapterRef) Instance() (EmbeddingAdapter, bool) {
	return r.instance, r.kind == embeddingAdapterInstance
}

func (r EmbeddingAdapterRef) RegisteredName() (string, bool) {
	return r.name, r.kind == embeddingAdapterRegistered
}

type EmbeddingSource struct {
	fields []string
	list   bool
}

func EmbeddingSourceField(field string) EmbeddingSource {
	return EmbeddingSource{fields: []string{field}}
}

func EmbeddingSourceFields(fields ...string) EmbeddingSource {
	return EmbeddingSource{fields: append([]string{}, fields...), list: true}
}

func (s EmbeddingSource) Fields() []string {
	return append([]string(nil), s.fields...)
}

func (s EmbeddingSource) IsList() bool {
	return s.list
}

type EmbeddingFieldConfig struct {
	Adapter EmbeddingAdapterRef
	Fields  map[string]EmbeddingSource
}

type IndexConfig struct {
	Schema            Schema
	Language          string
	Partitions        PartitionConfig
	DefaultScoring    ScoringMode
	BM25              BM25Params
	StopWords         StopWords
	Tokenizer         TokenizerSetting
	TrackPositions    Optional[bool]
	TextStorage       TextStorage
	VectorPromotion   *VectorIndexConfig
	Strict            bool
	Embedding         *EmbeddingFieldConfig
	Required          []string
	SurfaceForms      Optional[bool]
	PatternValueLimit Optional[int]
	Synonyms          []SynonymRule
}
