use std::error::Error;

/// The error that an adapter returns, which the engine reports under its own error code.
pub type AdapterError = Box<dyn Error + Send + Sync>;

/// Why the engine asks an embedding adapter for a vector.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EmbeddingPurpose {
    /// The text of a document that the engine writes.
    Document,
    /// The text of a search.
    Query,
}

/// Turns text into the vectors of a vector field, such as a call to an embedding model.
///
/// The engine checks every returned vector: one with the wrong length raises `EMBEDDING_DIMENSION_MISMATCH`, and
/// one that holds an infinite or NaN element raises `EMBEDDING_FAILED`. A close of the index waits for the write
/// that embeds a document, so an adapter that closes that index from the same thread never returns.
pub trait EmbeddingAdapter: Send + Sync {
    /// Returns the length of every vector that this adapter returns, which must equal the `vector[n]` of each field
    /// that it fills.
    fn dimensions(&self) -> usize;

    /// Embeds one text.
    fn embed(&self, input: &str, purpose: EmbeddingPurpose) -> Result<Vec<f32>, AdapterError>;

    /// Embeds several texts in one call, returning one vector per input in the same order.
    ///
    /// The default calls [`EmbeddingAdapter::embed`] once per input, so override it where the model takes a batch.
    fn embed_batch(
        &self,
        inputs: &[String],
        purpose: EmbeddingPurpose,
    ) -> Result<Vec<Vec<f32>>, AdapterError> {
        inputs
            .iter()
            .map(|input| self.embed(input, purpose))
            .collect()
    }
}

/// Scores how well each document answers a query, such as a cross-encoder, so that the engine can reorder the top
/// hits of a search.
pub trait RerankAdapter: Send + Sync {
    /// Returns one score per document, in the order of `documents`, where a higher score ranks higher.
    fn score(&self, query: &str, documents: &[String]) -> Result<Vec<f64>, AdapterError>;
}
