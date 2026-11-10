package engine

import "github.com/assetcorp/narsil/packages/go/engine/internal/model"

// Optional holds a setting that a caller may leave out, so that the engine
// tells an absent value apart from a zero one and applies its own default.
type Optional[T any] = model.Optional[T]

// Some returns an Optional that holds value, which is how a caller sets an
// optional field such as QueryParams.Limit.
func Some[T any](value T) Optional[T] {
	return model.Some(value)
}

// Document is one stored record: field names mapped to strings, numbers,
// booleans, lists, nested documents, time.Time values, byte slices, and, for
// a vector field, a []float32 or a list of numbers.
type Document = model.Document

// FieldType is the type that a schema gives one field, such as "string" or
// "vector[384]".
type FieldType = model.FieldType

// TextFieldOption is a suffix that turns on an extra search feature for a
// text field, applied with FieldType.WithOptions.
type TextFieldOption = model.TextFieldOption

// SchemaEntry is one value of a Schema: a FieldType for a leaf field, or a
// nested Schema for an object field.
type SchemaEntry = model.SchemaEntry

// Schema maps each field name of an index to its type or to a nested schema.
type Schema = model.Schema

const (
	// FieldString gives a field analysed full-text search over one string.
	FieldString = model.FieldString
	// FieldStringList gives a field analysed full-text search over a list of strings.
	FieldStringList = model.FieldStringList
	// FieldVerbatim gives a field exact matching on one unanalysed string.
	FieldVerbatim = model.FieldVerbatim
	// FieldVerbatimList gives a field exact matching on a list of unanalysed strings.
	FieldVerbatimList = model.FieldVerbatimList
	// FieldNumber gives a field range filters and sorting on one number.
	FieldNumber = model.FieldNumber
	// FieldNumberList gives a field range filters on a list of numbers.
	FieldNumberList = model.FieldNumberList
	// FieldBoolean gives a field filters on one boolean.
	FieldBoolean = model.FieldBoolean
	// FieldBooleanList gives a field filters on a list of booleans.
	FieldBooleanList = model.FieldBooleanList
	// FieldEnum gives a field equality filters and facets on one string value.
	FieldEnum = model.FieldEnum
	// FieldEnumList gives a field equality filters and facets on a list of string values.
	FieldEnumList = model.FieldEnumList
	// FieldGeopoint gives a field radius and polygon filters on a latitude and longitude.
	FieldGeopoint = model.FieldGeopoint
)

const (
	// TextFieldSortable lets a text field sort query results.
	TextFieldSortable = model.TextFieldSortable
	// TextFieldPattern lets a text field answer wildcard, regex, and substring filters.
	TextFieldPattern = model.TextFieldPattern
	// TextFieldPartial lets a text field match partial words.
	TextFieldPartial = model.TextFieldPartial
)

// VectorFieldType returns the field type of a vector field holding dimension
// numbers, such as "vector[384]".
func VectorFieldType(dimension int) FieldType {
	return model.VectorFieldType(dimension)
}

// ScoringMode picks where keyword search takes its term statistics from.
type ScoringMode = model.ScoringMode

const (
	// ScoringLocal scores each partition with its own term statistics.
	ScoringLocal = model.ScoringLocal
	// ScoringDFS scores with term statistics gathered from every partition first.
	ScoringDFS = model.ScoringDFS
	// ScoringBroadcast scores with term statistics that peers broadcast.
	ScoringBroadcast = model.ScoringBroadcast
)

// TextStorage picks whether stored document text stays in memory or on disk.
type TextStorage = model.TextStorage

const (
	// TextStorageMemory keeps stored document text in memory.
	TextStorageMemory = model.TextStorageMemory
	// TextStorageDisk keeps checkpointed document text on disk, which needs filesystem durability.
	TextStorageDisk = model.TextStorageDisk
)

// VectorQuantizationMode picks how many bits a vector graph spends on each value.
type VectorQuantizationMode = model.VectorQuantizationMode

const (
	// QuantizationOSQ8 stores each value in 8 bits.
	QuantizationOSQ8 = model.QuantizationOSQ8
	// QuantizationOSQ4 stores each value in 4 bits.
	QuantizationOSQ4 = model.QuantizationOSQ4
	// QuantizationOSQ2 stores each value in 2 bits.
	QuantizationOSQ2 = model.QuantizationOSQ2
	// QuantizationOSQ1 stores each value in 1 bit.
	QuantizationOSQ1 = model.QuantizationOSQ1
	// QuantizationNone searches full 32-bit values alone.
	QuantizationNone = model.QuantizationNone
)

// VectorStorageMode picks whether vector data stays in memory or on disk.
type VectorStorageMode = model.VectorStorageMode

const (
	// VectorStorageMemory keeps vectors in memory.
	VectorStorageMemory = model.VectorStorageMemory
	// VectorStorageDisk keeps checkpointed vectors in mapped files, which needs filesystem durability.
	VectorStorageDisk = model.VectorStorageDisk
)

// VectorMetric picks how a vector search compares two vectors.
type VectorMetric = model.VectorMetric

const (
	// MetricCosine compares the angle between two vectors.
	MetricCosine = model.MetricCosine
	// MetricDotProduct compares the dot product of two vectors.
	MetricDotProduct = model.MetricDotProduct
	// MetricEuclidean compares the straight-line distance between two vectors.
	MetricEuclidean = model.MetricEuclidean
)

// HNSWConfig sets the shape of a vector graph and the metric that builds it.
type HNSWConfig = model.HNSWConfig

// VectorIndexConfig sets when a vector field grows a graph and how it stores
// the vectors.
type VectorIndexConfig = model.VectorIndexConfig

// PartitionConfig sets how many partitions an index holds and how full each
// one may grow.
type PartitionConfig = model.PartitionConfig

// BM25FieldParams overrides the BM25 settings of one text field.
type BM25FieldParams = model.BM25FieldParams

// BM25Params sets the k1 and b values that keyword ranking uses.
type BM25Params = model.BM25Params

// EmbeddingAdapterRef names the embedding adapter of an index, either as an
// instance or as a name that RegisterEmbeddingAdapter binds.
type EmbeddingAdapterRef = model.EmbeddingAdapterRef

// UseEmbeddingAdapter returns a reference to an adapter instance. An engine
// with durability refuses an instance, because a restart cannot recover code.
func UseEmbeddingAdapter(adapter EmbeddingAdapter) EmbeddingAdapterRef {
	return model.EmbeddingAdapterInstance(adapter)
}

// NamedEmbeddingAdapter returns a reference to the adapter that
// RegisterEmbeddingAdapter binds under name, which survives a restart.
func NamedEmbeddingAdapter(name string) EmbeddingAdapterRef {
	return model.RegisteredEmbeddingAdapter(name)
}

// EmbeddingSource lists the text fields whose values an adapter embeds into
// one vector field.
type EmbeddingSource = model.EmbeddingSource

// EmbedField returns a source that embeds the text of one field.
func EmbedField(field string) EmbeddingSource {
	return model.EmbeddingSourceField(field)
}

// EmbedFields returns a source that embeds the text of several fields, joined
// by line breaks in the order given.
func EmbedFields(fields ...string) EmbeddingSource {
	return model.EmbeddingSourceFields(fields...)
}

// EmbeddingFieldConfig maps each vector field that the engine fills to the
// text fields it embeds, and names the adapter that does the work.
type EmbeddingFieldConfig = model.EmbeddingFieldConfig

// IndexConfig carries everything CreateIndex needs: the schema, the language,
// and the partitioning, scoring, analysis, vector, and embedding settings.
type IndexConfig = model.IndexConfig
