use std::collections::HashMap;

use narsil::{AdapterError, EmbeddingAdapter, EmbeddingPurpose, RerankAdapter};

pub const PARITY_EMBEDDING_ADAPTER: &str = "fixed";
pub const LENGTH_RERANK_ADAPTER: &str = "length";
pub const FAILING_RERANK_ADAPTER: &str = "broken";
pub const NAN_RERANK_ADAPTER: &str = "nan";
pub const SHORT_RERANK_ADAPTER: &str = "short";
pub const RERANK_FAILURE_TEXT: &str = "model offline";
pub const LENGTH_SCORE_MULTIPLIER: usize = 31;
pub const LENGTH_SCORE_MODULUS: usize = 1009;
pub const LENGTH_SCORE_DIVISOR: f64 = 13.0;

pub struct EmbedWith<F> {
    pub dimensions: usize,
    pub embed: F,
}

impl<F> EmbeddingAdapter for EmbedWith<F>
where
    F: Fn(&str) -> Result<Vec<f32>, AdapterError> + Send + Sync,
{
    fn dimensions(&self) -> usize {
        self.dimensions
    }

    fn embed(&self, input: &str, _purpose: EmbeddingPurpose) -> Result<Vec<f32>, AdapterError> {
        (self.embed)(input)
    }
}

pub struct RerankWith<F>(pub F);

impl<F> RerankAdapter for RerankWith<F>
where
    F: Fn(&str, &[String]) -> Result<Vec<f64>, AdapterError> + Send + Sync,
{
    fn score(&self, query: &str, documents: &[String]) -> Result<Vec<f64>, AdapterError> {
        (self.0)(query, documents)
    }
}

pub fn fixed_embedding(
    dimensions: usize,
    table: HashMap<String, Vec<f32>>,
) -> impl EmbeddingAdapter + 'static {
    EmbedWith {
        dimensions,
        embed: move |input: &str| {
            table
                .get(input)
                .cloned()
                .ok_or_else(|| AdapterError::from(format!("no vector for \"{input}\"")))
        },
    }
}

fn utf16_length(text: &str) -> usize {
    text.encode_utf16().count()
}

pub fn length_score(query: &str, document: &str) -> f64 {
    let raw = (utf16_length(document) * LENGTH_SCORE_MULTIPLIER + utf16_length(query))
        % LENGTH_SCORE_MODULUS;
    raw as f64 / LENGTH_SCORE_DIVISOR
}

pub fn parity_rerank_adapters() -> Vec<(&'static str, Box<dyn RerankAdapter>)> {
    vec![
        (
            LENGTH_RERANK_ADAPTER,
            Box::new(RerankWith(|query: &str, documents: &[String]| {
                Ok(documents
                    .iter()
                    .map(|document| length_score(query, document))
                    .collect())
            })),
        ),
        (
            FAILING_RERANK_ADAPTER,
            Box::new(RerankWith(|_: &str, _: &[String]| {
                Err(AdapterError::from(RERANK_FAILURE_TEXT))
            })),
        ),
        (
            NAN_RERANK_ADAPTER,
            Box::new(RerankWith(|_: &str, documents: &[String]| {
                Ok(documents.iter().map(|_| f64::NAN).collect())
            })),
        ),
        (
            SHORT_RERANK_ADAPTER,
            Box::new(RerankWith(|_: &str, documents: &[String]| {
                Ok(vec![1.0; documents.len().saturating_sub(1)])
            })),
        ),
    ]
}
