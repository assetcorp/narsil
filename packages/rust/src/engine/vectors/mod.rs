mod apply;
pub(crate) mod embed_documents;
pub(crate) mod embedding;
mod maintenance;
pub(crate) mod paths;
mod write_embedding;

use std::sync::Arc;

use crate::adapters::EmbeddingAdapter;
use crate::config::IndexConfig;
use crate::engine::adapter_registry::AdapterRegistry;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::pins::IndexSequence;
use crate::schema::{BaseType, CompiledSchema};
use crate::value::{Map, Value};
use crate::vector::field::VectorField;
use crate::vector::settings::VectorSettings;

pub(crate) use apply::DocumentVectors;
pub(crate) use embedding::EmbeddingBinding;
pub use maintenance::VectorMaintenanceStatus;
use paths::{set_value_at, take_value_at, value_at};

/// One vector field of an index: its schema path and the store and graph that hold its vectors.
pub(crate) struct IndexVectorField {
    pub(crate) path: String,
    pub(crate) field: Arc<VectorField>,
}

/// The vector fields of an index, in schema order, with the adapter binding that fills them from text.
pub(crate) struct IndexVectors {
    sequence: Arc<IndexSequence>,
    fields: Vec<IndexVectorField>,
    embedding: Option<EmbeddingBinding>,
    adapters: Arc<AdapterRegistry>,
}

impl IndexVectors {
    /// Builds an empty vector field for each `vector[n]` field of the schema.
    pub(crate) fn new(
        schema: &CompiledSchema,
        config: &IndexConfig,
        embedding: Option<EmbeddingBinding>,
        adapters: Arc<AdapterRegistry>,
    ) -> Result<IndexVectors> {
        let promotion = config.vector_promotion.as_ref();
        let filter_threshold = promotion.and_then(|found| found.filter_threshold);
        let sequence = Arc::new(IndexSequence::default());
        let mut fields = Vec::new();
        for field in &schema.fields {
            if field.field_type.base != BaseType::Vector {
                continue;
            }
            let settings = VectorSettings::resolve(
                &field.path,
                field.field_type.dimension as usize,
                promotion,
                filter_threshold,
            )?;
            fields.push(IndexVectorField {
                path: field.path.clone(),
                field: Arc::new(VectorField::new(settings, Arc::clone(&sequence))?),
            });
        }
        Ok(IndexVectors {
            sequence,
            fields,
            embedding,
            adapters,
        })
    }

    /// Returns every vector field of the index, in schema order, which a checkpoint saves and a restore fills.
    pub(crate) fn fields(&self) -> &[IndexVectorField] {
        &self.fields
    }

    /// Returns the vector field at `path`, or `None` where the schema declares no vector field there.
    pub(crate) fn field(&self, path: &str) -> Option<&Arc<VectorField>> {
        self.fields
            .iter()
            .find(|entry| entry.path == path)
            .map(|entry| &entry.field)
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.fields.is_empty()
    }

    pub(crate) fn sequence(&self) -> &Arc<IndexSequence> {
        &self.sequence
    }

    pub(crate) fn publish_writes(&self) {
        let sequence = self.sequence.next();
        for entry in &self.fields {
            entry.field.record_write_sequence(sequence);
        }
        self.sequence.publish(sequence);
    }

    pub(crate) fn embedding(&self) -> Option<&EmbeddingBinding> {
        self.embedding.as_ref()
    }

    pub(crate) fn adapters(&self) -> &AdapterRegistry {
        &self.adapters
    }

    /// Returns the embedding adapter that the index uses now, or `None` where it embeds nothing or its named
    /// adapter is not registered.
    pub(crate) fn embedding_adapter(&self) -> Option<Arc<dyn EmbeddingAdapter>> {
        self.embedding.as_ref()?.adapter(&self.adapters)
    }

    /// Raises `VECTOR_DIMENSION_MISMATCH` for a vector field that holds a list of finite numbers of the wrong length,
    /// which every engine checks before it validates the rest of the document.
    pub(crate) fn require_dimensions(&self, document: &Map) -> Result<()> {
        for entry in &self.fields {
            let Some(Value::Array(items)) = value_at(document, &entry.path) else {
                continue;
            };
            let numeric = items
                .iter()
                .all(|item| matches!(item, Value::Number(number) if number.is_finite()));
            let expected = entry.field.dimension();
            if numeric && items.len() != expected {
                return Err(NarsilError::new(
                    ErrorCode::VECTOR_DIMENSION_MISMATCH,
                    format!(
                        "Vector dimension mismatch for field \"{}\": expected {expected}, got {}",
                        entry.path,
                        items.len()
                    ),
                ));
            }
        }
        Ok(())
    }

    /// Moves every vector out of a document that passed validation, so that the partition stores none.
    ///
    /// An insert leaves a `null` vector field in the stored document, while an update clears every vector field,
    /// as every Narsil engine does.
    pub(crate) fn take_vectors(
        &self,
        document: &mut Map,
        clears_every_field: bool,
    ) -> DocumentVectors {
        let vectors = self
            .fields
            .iter()
            .map(|entry| {
                let holds_vector = matches!(value_at(document, &entry.path), Some(Value::Array(_)));
                if !holds_vector && !clears_every_field {
                    return None;
                }
                match take_value_at(document, &entry.path) {
                    Some(Value::Array(items)) => Some(
                        items
                            .iter()
                            .map(|item| item.as_f64().unwrap_or(0.0) as f32)
                            .collect(),
                    ),
                    _ => None,
                }
            })
            .collect();
        DocumentVectors::new(vectors)
    }

    pub(crate) fn pinned_vectors(&self, doc_id: &str, pin: i64) -> Result<DocumentVectors> {
        let vectors: Result<Vec<Option<Vec<f32>>>> = self
            .fields
            .iter()
            .map(|entry| entry.field.pinned_vector(doc_id, pin))
            .collect();
        vectors.map(DocumentVectors::new)
    }

    /// Puts vectors that [`IndexVectors::pinned_vectors`] returned back into their document, at the end and in
    /// schema order.
    pub(crate) fn attach(&self, vectors: DocumentVectors, document: &mut Map) {
        for (entry, vector) in self.fields.iter().zip(vectors.into_vectors()) {
            if let Some(vector) = vector {
                let values = vector
                    .into_iter()
                    .map(|element| Value::Number(f64::from(element)))
                    .collect();
                set_value_at(document, &entry.path, Value::Array(values));
            }
        }
    }
}
