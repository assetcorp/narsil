mod constants;
mod memory;

use super::Narsil;
use super::index::IndexState;
use crate::error::Result;
use crate::value::Value;
use constants::{KIBIBYTE_BYTES, PROCESS_STATUS_PATH, RESIDENT_SET_FIELD};
use memory::partition_bytes;

/// The figures that [`Narsil::get_stats`] reports for one index.
#[derive(Debug, Clone, PartialEq)]
pub struct IndexStats {
    /// The number of live documents that the index holds.
    pub document_count: u64,
    /// The number of partitions that the index spreads its documents across.
    pub partition_count: usize,
    /// An estimate of the heap bytes that the index holds, which [`Narsil::get_memory_stats`] describes.
    pub estimated_memory_bytes: u64,
    /// The language that analyses the index's text.
    pub language: String,
    /// The index's schema, in the shape that [`crate::IndexConfig::schema`] takes.
    pub schema: Value,
}

/// The figures that [`Narsil::get_partition_stats`] reports for one partition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PartitionStats {
    /// The position of the partition in the index, from 0.
    pub partition_id: usize,
    /// The number of live documents that the partition holds.
    pub document_count: u64,
    /// An estimate of the heap bytes that the partition's text segments hold.
    pub estimated_memory_bytes: u64,
}

/// The figures that [`Narsil::get_memory_stats`] reports for the whole engine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryStats {
    /// The resident set size of the process, which Linux reports and other systems leave as `None`.
    pub process_resident_bytes: Option<u64>,
    /// The sum of every open index's estimate.
    pub estimated_index_bytes: u64,
    /// The number of indexes that the engine holds open.
    pub open_index_count: usize,
}

fn vector_bytes(index: &IndexState) -> u64 {
    u64::try_from(index.vectors.memory_bytes()).unwrap_or(u64::MAX)
}

fn partition_stats(index: &IndexState) -> Vec<PartitionStats> {
    index
        .partitions()
        .iter()
        .enumerate()
        .map(|(partition_id, partition)| {
            let snapshot = partition.snapshot();
            PartitionStats {
                partition_id,
                document_count: snapshot.document_count(),
                estimated_memory_bytes: partition_bytes(&snapshot),
            }
        })
        .collect()
}

/// Returns the estimate of the bytes that the text segments of every partition of `index` hold.
pub(crate) fn text_bytes(index: &IndexState) -> u64 {
    partition_stats(index)
        .iter()
        .fold(0u64, |total, partition| {
            total.saturating_add(partition.estimated_memory_bytes)
        })
}

/// Returns the estimate of the bytes that `index` holds in memory, which [`Narsil::get_stats`] reports.
pub(crate) fn index_bytes(index: &IndexState) -> u64 {
    partition_stats(index)
        .iter()
        .fold(vector_bytes(index), |total, partition| {
            total.saturating_add(partition.estimated_memory_bytes)
        })
}

fn process_resident_bytes() -> Option<u64> {
    let status = std::fs::read_to_string(PROCESS_STATUS_PATH).ok()?;
    let line = status
        .lines()
        .find_map(|line| line.strip_prefix(RESIDENT_SET_FIELD))?;
    let kibibytes: u64 = line.trim().strip_suffix("kB")?.trim().parse().ok()?;
    kibibytes.checked_mul(KIBIBYTE_BYTES)
}

impl Narsil {
    /// Returns the document count, partition count, memory estimate, language, and schema of one index.
    ///
    /// The memory estimate counts the arrays, documents, and vectors that the index holds in memory; the
    /// reference engine estimates its JavaScript objects with a different formula, so the two engines report
    /// different figures for the same documents. A closed index stays closed: it reports the document and
    /// partition counts of its last checkpoint and a memory estimate of 0. Fails with `INDEX_NOT_FOUND` where the
    /// engine holds no index called `index`.
    pub fn get_stats(&self, index: &str) -> Result<IndexStats> {
        self.inner.guard_shutdown()?;
        if self.inner.open_index_named(index).is_none()
            && let Some(closed) = self.inner.lifecycle.closed_index(index)
        {
            return Ok(IndexStats {
                document_count: closed.document_count,
                partition_count: closed.partition_count,
                estimated_memory_bytes: 0,
                language: closed.language,
                schema: closed.config.schema.clone(),
            });
        }
        let index = self.inner.open_index(index)?;
        let partitions = partition_stats(&index);
        let document_count = partitions
            .iter()
            .map(|partition| partition.document_count)
            .sum();
        let estimated_memory_bytes = partitions
            .iter()
            .fold(vector_bytes(&index), |total, partition| {
                total.saturating_add(partition.estimated_memory_bytes)
            });
        Ok(IndexStats {
            document_count,
            partition_count: partitions.len(),
            estimated_memory_bytes,
            language: index.analyser().language().name().to_string(),
            schema: index.config().schema.clone(),
        })
    }

    /// Returns the document count and memory estimate of each partition of one index, in partition order.
    ///
    /// Each estimate covers the partition's text segments alone, so the vector fields that
    /// [`Narsil::get_stats`] adds stay out of it. A closed index stays closed and reports no partitions. Fails
    /// with `INDEX_NOT_FOUND` where the engine holds no index called `index`.
    pub fn get_partition_stats(&self, index: &str) -> Result<Vec<PartitionStats>> {
        self.inner.guard_shutdown()?;
        if self.inner.open_index_named(index).is_none() && self.inner.lifecycle.holds_closed(index)
        {
            return Ok(Vec::new());
        }
        Ok(partition_stats(&*self.inner.open_index(index)?))
    }

    /// Returns the process's resident memory with the estimate of every open index, which works after
    /// [`Narsil::shutdown`] too.
    ///
    /// An index's estimate counts the IDs, stored documents, terms, postings, positions, value columns, and
    /// vectors that it holds in memory, from the capacity of each array. It leaves out the sections that a paged
    /// segment reads from its file, the native core's allocations, and the allocator's overhead, so it can fall
    /// below what the process spends on the index.
    pub fn get_memory_stats(&self) -> MemoryStats {
        let indexes = self.inner.index_list();
        let estimated_index_bytes = indexes.iter().fold(0u64, |total, index| {
            total.saturating_add(index_bytes(index))
        });
        MemoryStats {
            process_resident_bytes: process_resident_bytes(),
            estimated_index_bytes,
            open_index_count: indexes.len(),
        }
    }
}
