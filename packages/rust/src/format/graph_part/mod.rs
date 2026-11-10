mod assemble;
mod decode;
mod encode;

pub(crate) use assemble::assemble_graph_parts;
pub(crate) use decode::{decode_earlier_graph_payload, decode_graph_part};
pub(crate) use encode::encode_graph_part;

pub(crate) const VECTOR_GRAPH_PAYLOAD_VERSION: u8 = 1;
pub(crate) const VECTOR_GRAPH_PART_PAYLOAD_VERSION: u8 = 2;
pub(crate) const GRAPH_PART_ENVELOPE_VERSION: u8 = 2;
pub(crate) const VECTOR_GRAPH_PART_VECTORS: usize = 16_384;
pub(crate) const MIN_M: u32 = 2;
pub(crate) const MAX_M: u32 = 512;
const GRAPH_PREFIX: &str = "Invalid vector graph payload: ";
const PART_PREFIX: &str = "Invalid vector graph part payload: ";

/// The distance that a graph was built with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Metric {
    Cosine,
    DotProduct,
    Euclidean,
}

impl Metric {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Metric::Cosine => "cosine",
            Metric::DotProduct => "dotProduct",
            Metric::Euclidean => "euclidean",
        }
    }

    pub(crate) fn parse(name: &str) -> Option<Metric> {
        match name {
            "cosine" => Some(Metric::Cosine),
            "dotProduct" => Some(Metric::DotProduct),
            "euclidean" => Some(Metric::Euclidean),
            _ => None,
        }
    }
}

/// One HNSW graph over a run of numbered vectors: a level per vector and, for every node, a list per layer.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct NumberedGraph {
    pub(crate) entry_point: Option<u32>,
    pub(crate) max_layer: u8,
    pub(crate) m: u32,
    pub(crate) ef_construction: u16,
    pub(crate) metric: Metric,
    pub(crate) levels: Vec<u8>,
    pub(crate) neighbours: Vec<u32>,
    pub(crate) shuffled_build_count: Option<u32>,
    pub(crate) calibrated_mean_length: Option<f64>,
}

/// The decoded payload of one graph part file.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct GraphPart {
    pub(crate) field_name: String,
    pub(crate) graphs: Vec<NumberedGraph>,
}

/// The graphs of one field, each split into parts of `part_size` vectors.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct GraphParts {
    pub(crate) field_name: String,
    pub(crate) part_size: Vec<usize>,
    pub(crate) graphs: Vec<Vec<NumberedGraph>>,
}
