use std::sync::Arc;

use crate::error::{ErrorCode, NarsilError, Result};
use crate::vector::field::VectorField;

use super::IndexVectors;

/// The upkeep state of one vector field, which tells a caller when [`crate::Narsil::compact_vectors`] or
/// [`crate::Narsil::optimize_vectors`] pays off.
#[derive(Debug, Clone, PartialEq)]
pub struct VectorMaintenanceStatus {
    /// The schema path of the vector field.
    pub field_name: String,
    /// The share of the field's graph nodes that removed or replaced vectors still occupy, from 0 to 1.
    pub tombstone_ratio: f64,
    /// The number of graphs that the field holds, which is 0 before the field builds its first graph.
    pub graph_count: u32,
    /// The number of vectors that wait outside the graph, which every search scores exactly.
    pub buffer_size: u64,
    /// Whether a background build is folding vectors into the graph now.
    pub building: bool,
    /// Whether a build waits for memory, which this engine never does.
    pub waiting_for_memory: bool,
    /// Whether the field is reading its vectors back from checkpoint files.
    pub loading_from_files: bool,
    /// The estimated time that a compaction takes, in milliseconds.
    pub estimated_compact_ms: u64,
    /// The estimated time that an optimisation takes, in milliseconds.
    pub estimated_optimize_ms: u64,
}

impl IndexVectors {
    /// Returns every vector field of the index, or only the one at `field`, raising `INDEX_NOT_FOUND` where the
    /// index holds no vector field there.
    fn chosen(&self, index_name: &str, field: Option<&str>) -> Result<Vec<&Arc<VectorField>>> {
        let Some(path) = field else {
            return Ok(self.fields.iter().map(|entry| &entry.field).collect());
        };
        match self.field(path) {
            Some(found) => Ok(vec![found]),
            None => Err(NarsilError::new(
                ErrorCode::INDEX_NOT_FOUND,
                format!("Vector field \"{path}\" not found in index \"{index_name}\""),
            )),
        }
    }

    /// Takes the vectors that removals and replacements left behind out of the chosen fields.
    pub(crate) fn compact(&self, index_name: &str, field: Option<&str>) -> Result<()> {
        for chosen in self.chosen(index_name, field)? {
            chosen.compact()?;
        }
        Ok(())
    }

    /// Folds every waiting vector of the chosen fields into their graphs, rebuilding a graph that removals have
    /// thinned, and returns once the work is done.
    pub(crate) fn optimize(&self, index_name: &str, field: Option<&str>) -> Result<()> {
        for chosen in self.chosen(index_name, field)? {
            chosen.optimize()?;
            chosen.wait_for_builds()?;
        }
        Ok(())
    }

    pub(crate) fn maintenance_status(&self) -> Vec<VectorMaintenanceStatus> {
        self.fields
            .iter()
            .map(|entry| {
                let status = entry.field.maintenance_status();
                VectorMaintenanceStatus {
                    field_name: entry.path.clone(),
                    tombstone_ratio: status.tombstone_ratio,
                    graph_count: status.graph_count,
                    buffer_size: status.buffer_size,
                    building: status.building,
                    waiting_for_memory: status.waiting_for_memory,
                    loading_from_files: status.loading_from_files,
                    estimated_compact_ms: status.estimated_compact_ms,
                    estimated_optimize_ms: status.estimated_optimize_ms,
                }
            })
            .collect()
    }

    /// Returns the bytes that the vector fields hold.
    pub(crate) fn memory_bytes(&self) -> usize {
        self.fields
            .iter()
            .map(|entry| entry.field.memory_bytes())
            .sum()
    }
}
