use crate::error::Result;

use super::IndexVectors;

/// The vectors of one document, one entry per vector field of the index in schema order, where `None` means the
/// document holds no vector for that field.
pub(crate) struct DocumentVectors {
    vectors: Vec<Option<Vec<f32>>>,
}

/// What an update replaced in each vector field, so that a failed write can put it back.
#[derive(Default)]
pub(crate) struct VectorUndo {
    replaced: Vec<(usize, Option<Vec<f32>>)>,
}

impl DocumentVectors {
    pub(crate) fn new(vectors: Vec<Option<Vec<f32>>>) -> DocumentVectors {
        DocumentVectors { vectors }
    }

    /// Returns the vector of the field at `position` in schema order.
    pub(crate) fn get(&self, position: usize) -> Option<&[f32]> {
        self.vectors.get(position)?.as_deref()
    }

    pub(crate) fn into_vectors(self) -> Vec<Option<Vec<f32>>> {
        self.vectors
    }
}

impl IndexVectors {
    /// Stores the vectors of a new document, removing those it stored already where a later field refuses its
    /// vector, so that a failed insert leaves no vector behind.
    pub(crate) fn insert_vectors(&self, doc_id: &str, vectors: &DocumentVectors) -> Result<()> {
        for (position, entry) in self.fields.iter().enumerate() {
            let Some(vector) = vectors.get(position) else {
                continue;
            };
            if let Err(error) = entry.field.insert(doc_id, vector) {
                self.remove_vectors_before(doc_id, vectors, position);
                return Err(error);
            }
        }
        Ok(())
    }

    fn remove_vectors_before(&self, doc_id: &str, vectors: &DocumentVectors, end: usize) {
        for (position, entry) in self.fields.iter().enumerate().take(end) {
            if vectors.get(position).is_some() {
                let _ = entry.field.remove(doc_id);
            }
        }
    }

    /// Replaces the vectors of an existing document with `vectors`, removing those that it no longer holds, and
    /// returns what it replaced. Where a field refuses its new vector, it puts back every field that it changed.
    pub(crate) fn update_vectors(
        &self,
        doc_id: &str,
        vectors: &DocumentVectors,
    ) -> Result<VectorUndo> {
        let mut undo = VectorUndo::default();
        for (position, entry) in self.fields.iter().enumerate() {
            let previous = entry.field.get_vector(doc_id);
            let outcome = match vectors.get(position) {
                Some(vector) if previous.as_deref() == Some(vector) => continue,
                Some(vector) => entry.field.insert(doc_id, vector),
                None if previous.is_none() => continue,
                None => entry.field.remove(doc_id),
            };
            match outcome {
                Ok(()) => undo.replaced.push((position, previous)),
                Err(error) => {
                    self.undo(doc_id, undo);
                    return Err(error);
                }
            }
        }
        Ok(undo)
    }

    /// Puts back what [`IndexVectors::update_vectors`] replaced.
    pub(crate) fn undo(&self, doc_id: &str, undo: VectorUndo) {
        for (position, previous) in undo.replaced.into_iter().rev() {
            let Some(entry) = self.fields.get(position) else {
                continue;
            };
            let _ = match previous {
                Some(vector) => entry.field.insert(doc_id, &vector),
                None => entry.field.remove(doc_id),
            };
        }
    }

    /// Removes every vector of a document, which succeeds for a field that holds none.
    pub(crate) fn remove_vectors(&self, doc_id: &str) -> Result<()> {
        let mut first_error = None;
        for entry in &self.fields {
            if let Err(error) = entry.field.remove(doc_id)
                && first_error.is_none()
            {
                first_error = Some(error);
            }
        }
        first_error.map_or(Ok(()), Err)
    }
}
