use std::sync::Arc;

use crate::adapters::EmbeddingAdapter;
use crate::analysis::{StopWords, Tokenizer};
use crate::value::Value;

/// How the partitions of a search gather the statistics that BM25 scores with.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ScoringMode {
    /// Each partition scores with its own document count, document frequencies, and average field lengths.
    Local,
    /// The engine sums the statistics of every partition before it scores, which ranks exactly.
    Dfs,
    /// Each partition scores with the statistics that the partitions last published.
    Broadcast,
}

impl ScoringMode {
    /// Returns the name that an index configuration stores for this mode.
    pub fn name(self) -> &'static str {
        match self {
            ScoringMode::Local => "local",
            ScoringMode::Dfs => "dfs",
            ScoringMode::Broadcast => "broadcast",
        }
    }

    pub(crate) fn parse(name: &str) -> Option<ScoringMode> {
        Some(match name {
            "local" => ScoringMode::Local,
            "dfs" => ScoringMode::Dfs,
            "broadcast" => ScoringMode::Broadcast,
            _ => return None,
        })
    }
}

/// The BM25 parameters of one field.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Bm25FieldParams {
    /// How fast term frequency saturates, from 0 to 1,000.
    pub k1: Option<f64>,
    /// How much a field's length normalises its score, from 0 to 1.
    pub b: Option<f64>,
}

/// BM25 parameters for an index or a search, with an optional pair per text field.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Bm25Params {
    /// How fast term frequency saturates, from 0 to 1,000, and 1.2 where no level sets it.
    pub k1: Option<f64>,
    /// How much a field's length normalises its score, from 0 to 1, and 0.75 where no level sets it.
    pub b: Option<f64>,
    /// The parameters of named `string` and `string[]` fields, in the order that the caller gives them.
    pub fields: Option<Vec<(String, Bm25FieldParams)>>,
}

/// How an index grows into partitions.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct PartitionConfig {
    /// A partition holds at most this many documents.
    pub max_docs_per_partition: Option<u64>,
    /// The index holds at most this many partitions.
    pub max_partitions: Option<u64>,
    /// The fraction of capacity, above 0 and at most 1, at which the engine reports that a partition is filling up.
    pub watermark: Option<f64>,
}

/// Where an index keeps its text and its documents.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Storage {
    /// In memory.
    Memory,
    /// In the checkpoint files of write-ahead log durability, read back on demand.
    Disk,
}

impl Storage {
    /// Returns the name that an index configuration stores for this place.
    pub fn name(self) -> &'static str {
        match self {
            Storage::Memory => "memory",
            Storage::Disk => "disk",
        }
    }

    pub(crate) fn parse(name: &str) -> Option<Storage> {
        Some(match name {
            "memory" => Storage::Memory,
            "disk" => Storage::Disk,
            _ => return None,
        })
    }
}

/// How a vector index compresses its vectors for the graph search.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Quantization {
    /// Optimised scalar quantisation at 8 bits per dimension.
    Osq8,
    /// Optimised scalar quantisation at 4 bits per dimension.
    Osq4,
    /// Optimised scalar quantisation at 2 bits per dimension.
    Osq2,
    /// Optimised scalar quantisation at 1 bit per dimension.
    Osq1,
    /// Full float32 vectors.
    None,
}

impl Quantization {
    /// Returns the name that an index configuration stores for this mode.
    pub fn name(self) -> &'static str {
        match self {
            Quantization::Osq8 => "osq8",
            Quantization::Osq4 => "osq4",
            Quantization::Osq2 => "osq2",
            Quantization::Osq1 => "osq1",
            Quantization::None => "none",
        }
    }

    pub(crate) fn parse(name: &str) -> Option<Quantization> {
        Some(match name {
            "osq8" => Quantization::Osq8,
            "osq4" => Quantization::Osq4,
            "osq2" => Quantization::Osq2,
            "osq1" => Quantization::Osq1,
            "none" => Quantization::None,
            _ => return None,
        })
    }

    pub(crate) fn bits(self) -> u8 {
        match self {
            Quantization::Osq8 => 8,
            Quantization::Osq4 => 4,
            Quantization::Osq2 => 2,
            Quantization::Osq1 => 1,
            Quantization::None => 0,
        }
    }
}

/// How a vector index measures how close two vectors are.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Metric {
    /// The cosine of the angle between the vectors.
    Cosine,
    /// The dot product of the vectors.
    DotProduct,
    /// The Euclidean distance between the vectors, ranked nearest first.
    Euclidean,
}

impl Metric {
    /// Returns the name that an index configuration stores for this metric.
    pub fn name(self) -> &'static str {
        match self {
            Metric::Cosine => "cosine",
            Metric::DotProduct => "dotProduct",
            Metric::Euclidean => "euclidean",
        }
    }

    pub(crate) fn parse(name: &str) -> Option<Metric> {
        Some(match name {
            "cosine" => Metric::Cosine,
            "dotProduct" => Metric::DotProduct,
            "euclidean" => Metric::Euclidean,
            _ => return None,
        })
    }
}

/// The settings of the HNSW graph of a vector field.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct HnswSettings {
    /// The number of neighbours that each node links to above layer 0, from 2 to 512, and 16 by default.
    pub m: Option<u32>,
    /// The candidate list length while the engine builds the graph, and 200 by default.
    pub ef_construction: Option<u32>,
    /// The similarity metric, and cosine by default.
    pub metric: Option<Metric>,
}

/// When and how the engine builds a vector index for each vector field.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct VectorPromotion {
    /// A field builds its graph once it holds this many vectors.
    pub threshold: Option<u64>,
    /// A filtered vector search whose filter keeps less than this share of the field's vectors, from 0 to 1, scores
    /// every candidate that the filter keeps.
    pub filter_threshold: Option<f64>,
    /// The graph settings.
    pub hnsw: Option<HnswSettings>,
    /// How the field compresses its vectors.
    pub quantization: Option<Quantization>,
    /// Where the field keeps its full vectors.
    pub storage: Option<Storage>,
}

/// The embedding adapter of an index, as an instance or as a name that the engine registers.
#[derive(Clone)]
pub enum AdapterSetting {
    /// An adapter instance. A durable engine refuses it, because a checkpoint persists no code.
    Instance(Arc<dyn EmbeddingAdapter>),
    /// The name of an adapter that the engine holds.
    Named(String),
}

/// The vector fields that an index fills by embedding the text of other fields.
#[derive(Clone)]
pub struct EmbeddingConfig {
    /// Each vector field with the `string` fields whose text the engine embeds into it, in order.
    pub fields: Vec<(String, Vec<String>)>,
    /// The adapter that embeds the text, or `None` for the engine's default adapter.
    pub adapter: Option<AdapterSetting>,
}

/// The stop words of an index, as a name, a set, or a function.
#[derive(Clone, Debug)]
pub enum StopWordsSetting {
    /// The name of a stop word set that the engine holds.
    Named(String),
    /// The words themselves.
    Words(StopWords),
}

/// The tokenizer of an index, as an instance or as a name that the engine registers.
#[derive(Clone)]
pub enum TokenizerSetting {
    /// A tokenizer instance. A durable engine refuses it, because a checkpoint persists no code.
    Instance(Arc<dyn Tokenizer>),
    /// The name of a tokenizer that the engine holds.
    Named(String),
}

/// One rule of a synonym set.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SynonymRule {
    /// Each of 2 to 100 words matches every other word of the rule.
    TwoWay(Vec<String>),
    /// Each of 1 to 99 synonyms matches `word`, while `word` adds nothing to a search for a synonym.
    OneWay {
        /// The word that the synonyms expand.
        word: String,
        /// The words that a search for `word` also matches.
        synonyms: Vec<String>,
    },
}

/// Everything that an index is created with.
#[derive(Clone, Default)]
pub struct IndexConfig {
    /// The nested schema, which maps each field to a type name such as `string` or `vector[384]`.
    pub schema: Value,
    /// The language that analyses the text fields, and `english` by default.
    pub language: Option<String>,
    /// How the index grows into partitions.
    pub partitions: Option<PartitionConfig>,
    /// How a search gathers BM25 statistics, and local by default.
    pub default_scoring: Option<ScoringMode>,
    /// The BM25 parameters of the index.
    pub bm25: Option<Bm25Params>,
    /// The stop words, which replace the language's stop words.
    pub stop_words: Option<StopWordsSetting>,
    /// A tokenizer, which replaces the language's analysis.
    pub tokenizer: Option<TokenizerSetting>,
    /// Whether the index stores token positions, which phrase search needs. True by default.
    pub track_positions: Option<bool>,
    /// Where the index keeps its text.
    pub text_storage: Option<Storage>,
    /// When and how the engine builds the vector indexes.
    pub vector_promotion: Option<VectorPromotion>,
    /// Whether the index refuses a document that holds a field the schema lacks.
    pub strict: Option<bool>,
    /// The vector fields that the engine fills by embedding text.
    pub embedding: Option<EmbeddingConfig>,
    /// The field paths that every document must hold.
    pub required: Option<Vec<String>>,
    /// Whether the index keeps each word as written beside its stem, which completions and partial words need. True
    /// by default.
    pub surface_forms: Option<bool>,
    /// The longest value, in code points, of a field that takes the `pattern` option.
    pub pattern_value_limit: Option<u64>,
    /// The synonym set.
    pub synonyms: Option<Vec<SynonymRule>>,
}

impl std::fmt::Debug for IndexConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("IndexConfig")
            .field("schema", &self.schema)
            .field("language", &self.language)
            .field("partitions", &self.partitions)
            .field("default_scoring", &self.default_scoring)
            .field("bm25", &self.bm25)
            .field("track_positions", &self.track_positions)
            .field("strict", &self.strict)
            .finish_non_exhaustive()
    }
}

impl IndexConfig {
    /// Returns a configuration with this schema and every other setting at its default.
    pub fn new(schema: Value) -> IndexConfig {
        IndexConfig {
            schema,
            ..IndexConfig::default()
        }
    }
}
