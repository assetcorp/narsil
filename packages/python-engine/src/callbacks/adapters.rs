use std::sync::Arc;

use narsil::{
    AdapterError, EmbeddingAdapter, EmbeddingPurpose, ErrorCode, NarsilError, RerankAdapter,
};
use pyo3::prelude::*;

use super::reentry::Reentry;
use super::retained::Retained;
use super::{CallbackFailure, call_python};
use crate::convert::fields::{floats_of, items_of, number_of, whole_of};
use crate::errors::config_invalid;

fn purpose_name(purpose: EmbeddingPurpose) -> &'static str {
    match purpose {
        EmbeddingPurpose::Document => "document",
        EmbeddingPurpose::Query => "query",
    }
}

fn boxed(error: NarsilError) -> AdapterError {
    Box::new(error)
}

pub(crate) struct PythonEmbeddingAdapter {
    object: Retained,
    dimensions: usize,
    batches: bool,
    subject: String,
}

impl PythonEmbeddingAdapter {
    pub(crate) fn wrap(
        object: &Bound<'_, PyAny>,
        label: &str,
    ) -> Result<Arc<dyn EmbeddingAdapter>, NarsilError> {
        let embeds = object
            .getattr("embed")
            .map(|embed| embed.is_callable())
            .unwrap_or(false);
        if !embeds {
            return Err(config_invalid(format!(
                "{label} must be a name or an object with an embed(text, purpose) method"
            )));
        }
        let path = format!("{label}.dimensions");
        let dimensions = object
            .getattr("dimensions")
            .map_err(|_| config_invalid(format!("{path} is required")))?;
        let dimensions = whole_of(&dimensions, &path)?;
        let dimensions = usize::try_from(dimensions)
            .ok()
            .filter(|dimensions| *dimensions >= 1)
            .ok_or_else(|| {
                config_invalid(format!("{path} must be a whole number of at least 1"))
            })?;
        let batches = object
            .getattr("embed_batch")
            .map(|batch| batch.is_callable())
            .unwrap_or(false);
        Ok(Arc::new(PythonEmbeddingAdapter {
            object: Retained::new(object),
            dimensions,
            batches,
            subject: format!("The embedding adapter {label}"),
        }))
    }
}

impl EmbeddingAdapter for PythonEmbeddingAdapter {
    fn dimensions(&self) -> usize {
        self.dimensions
    }

    fn embed(&self, input: &str, purpose: EmbeddingPurpose) -> Result<Vec<f32>, AdapterError> {
        let reentry = self.object.awaited_by_engine();
        call_python(ErrorCode::EMBEDDING_FAILED, &self.subject, reentry, |py| {
            let vector = self
                .object
                .bind(py)?
                .call_method1("embed", (input, purpose_name(purpose)))?;
            floats_of(&vector, "the vector that embed returned").map_err(CallbackFailure::Refused)
        })
        .map_err(boxed)
    }

    fn embed_batch(
        &self,
        inputs: &[String],
        purpose: EmbeddingPurpose,
    ) -> Result<Vec<Vec<f32>>, AdapterError> {
        if !self.batches {
            return inputs
                .iter()
                .map(|input| self.embed(input, purpose))
                .collect();
        }
        let reentry = self.object.awaited_by_engine();
        call_python(ErrorCode::EMBEDDING_FAILED, &self.subject, reentry, |py| {
            let vectors = self
                .object
                .bind(py)?
                .call_method1("embed_batch", (inputs.to_vec(), purpose_name(purpose)))?;
            let label = "the list that embed_batch returned";
            let vectors = items_of(&vectors, label)?;
            let mut embedded = Vec::with_capacity(vectors.len());
            for (at, vector) in vectors.iter().enumerate() {
                embedded.push(floats_of(vector, &format!("{label}[{at}]"))?);
            }
            Ok(embedded)
        })
        .map_err(boxed)
    }
}

pub(crate) struct PythonRerankAdapter {
    object: Retained,
    subject: String,
}

impl PythonRerankAdapter {
    pub(crate) fn wrap(
        object: &Bound<'_, PyAny>,
        name: &str,
    ) -> Result<Arc<dyn RerankAdapter>, NarsilError> {
        let scores = object
            .getattr("score")
            .map(|score| score.is_callable())
            .unwrap_or(false);
        if !scores {
            return Err(config_invalid(format!(
                "The rerank adapter \"{name}\" must be an object with a score(query, documents) method"
            )));
        }
        Ok(Arc::new(PythonRerankAdapter {
            object: Retained::new(object),
            subject: format!("The rerank adapter \"{name}\""),
        }))
    }
}

impl RerankAdapter for PythonRerankAdapter {
    fn score(&self, query: &str, documents: &[String]) -> Result<Vec<f64>, AdapterError> {
        call_python(
            ErrorCode::RERANK_FAILED,
            &self.subject,
            Reentry::Allowed,
            |py| {
                let scores = self
                    .object
                    .bind(py)?
                    .call_method1("score", (query, documents.to_vec()))?;
                let label = "the scores that score returned";
                let items = items_of(&scores, label)?;
                let mut numbers = Vec::with_capacity(items.len());
                for (at, item) in items.iter().enumerate() {
                    numbers.push(number_of(item, &format!("{label}[{at}]"))?);
                }
                Ok(numbers)
            },
        )
        .map_err(boxed)
    }
}
