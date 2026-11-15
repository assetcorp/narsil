use super::ProcessMemory;
use super::bound::{DocumentBound, DocumentCost};
use super::guard::MemoryGuard;
use crate::engine::index::IndexState;
use crate::error::{ErrorCode, NarsilError};
use crate::index::tail_growth::tail_growth_bytes;
use crate::keyword::growing::KeywordAdditions;
use crate::value::{Map, Value};

const WRITE_WOULD_FILL_MEMORY_REASON: &str = "write_would_fill_memory";
const WRITE_EXCEEDS_MEMORY_REASON: &str = "write_exceeds_memory";
const UNBOUNDED_DOCUMENT_BYTES: u64 = 0;

pub(crate) struct ProjectedGroup<'a> {
    guard: Option<&'a MemoryGuard>,
    bytes: u64,
    pub(crate) count: usize,
}

impl Drop for ProjectedGroup<'_> {
    fn drop(&mut self) {
        if let Some(guard) = self.guard {
            guard.release(self.bytes);
        }
    }
}

pub(crate) struct WriteProjection<'a> {
    guard: &'a MemoryGuard,
    index: &'a IndexState,
    bound: DocumentBound,
    costs: Vec<DocumentCost>,
    counted: Vec<bool>,
}

fn number(value: u64) -> Value {
    Value::Number(value as f64)
}

pub(crate) fn refused_after(index_name: &str, doc_id: &str, refused_doc_id: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::MEMORY_WRITE_BLOCKED,
        format!(
            "The engine refuses document '{doc_id}' for index '{index_name}' because document '{refused_doc_id}' before it in the batch would not fit in the engine's memory. Retry the refused documents once the writes in progress finish."
        ),
    )
    .with_details([
        ("reason", Value::from(WRITE_WOULD_FILL_MEMORY_REASON)),
        ("indexName", Value::from(index_name)),
        ("docId", Value::from(doc_id)),
        ("refusedDocId", Value::from(refused_doc_id)),
    ])
}

pub(crate) fn reserve_for_document<'a>(
    guard: &'a MemoryGuard,
    index: &'a IndexState,
    document: &Map,
) -> Result<ProjectedGroup<'a>, NarsilError> {
    let mut projection = WriteProjection::new(guard, index, std::iter::once(document));
    if projection
        .costs
        .first()
        .is_none_or(|cost| cost.bytes == UNBOUNDED_DOCUMENT_BYTES)
    {
        return Ok(ProjectedGroup {
            guard: None,
            bytes: 0,
            count: 1,
        });
    }
    projection.take_group(0, 1, |_| Some(document))
}

fn block_bytes_of(guard: &MemoryGuard, figures: &ProcessMemory) -> u64 {
    (guard.fractions.block * figures.limit_bytes as f64).floor() as u64
}

impl<'a> WriteProjection<'a> {
    pub(crate) fn new<'d>(
        guard: &'a MemoryGuard,
        index: &'a IndexState,
        documents: impl Iterator<Item = &'d Map>,
    ) -> WriteProjection<'a> {
        let bound = DocumentBound::of(index);
        let costs: Vec<DocumentCost> = documents.map(|document| bound.cost_of(document)).collect();
        let counted = vec![false; costs.len()];
        WriteProjection {
            guard,
            index,
            bound,
            costs,
            counted,
        }
    }

    fn count_exactly(&mut self, position: usize, document: Option<&Map>) {
        let (Some(counted), Some(document)) = (self.counted.get_mut(position), document) else {
            return;
        };
        if *counted {
            return;
        }
        *counted = true;
        let Some(exact) = self.bound.counted_cost_of(document) else {
            return;
        };
        if let Some(cost) = self.costs.get_mut(position)
            && exact.bytes < cost.bytes
        {
            *cost = exact;
        }
    }

    fn growth_bytes(&self, documents: usize, shape: &DocumentCost) -> u64 {
        if documents == 0 {
            return 0;
        }
        let keyword = KeywordAdditions {
            ordinals: 0,
            fields: self.bound.text_field_count(),
            terms: usize::try_from(shape.terms).unwrap_or(usize::MAX),
            units: usize::try_from(shape.units).unwrap_or(usize::MAX),
        };
        let values = usize::try_from(shape.values).unwrap_or(usize::MAX);
        let partitions = self.index.partitions();
        let mut bytes = 0usize;
        for partition in partitions.iter() {
            bytes = bytes.saturating_add(tail_growth_bytes(partition, documents, values, keyword));
        }
        for entry in self.index.vectors.fields() {
            bytes = bytes.saturating_add(entry.field.growth_bytes(documents));
        }
        bytes as u64
    }

    fn fitting_count<'d>(
        &mut self,
        figures: &ProcessMemory,
        reserved_before: u64,
        start: usize,
        end: usize,
        document_at: &impl Fn(usize) -> Option<&'d Map>,
    ) -> usize {
        let room = self.guard.fractions.block * figures.limit_bytes as f64
            - figures.process_bytes as f64
            - reserved_before as f64;
        let mut whole = DocumentCost::default();
        for cost in &self.costs[start..end] {
            whole.add(cost);
        }
        let most_growth = self.growth_bytes(end - start, &whole) as f64;
        let mut taken = DocumentCost::default();
        let mut count = 0;
        while start + count < end {
            let fits = |projection: &Self| {
                let mut next = taken;
                next.add(&projection.costs[start + count]);
                let bytes = next.bytes as f64;
                bytes + most_growth <= room
                    || bytes + projection.growth_bytes(count + 1, &next) as f64 <= room
            };
            if !fits(self) {
                self.count_exactly(start + count, document_at(start + count));
                if !fits(self) {
                    break;
                }
            }
            taken.add(&self.costs[start + count]);
            count += 1;
        }
        count
    }

    fn reserve_if_unchanged(
        &self,
        reserved_before: u64,
        start: usize,
        count: usize,
    ) -> Option<ProjectedGroup<'a>> {
        let mut shape = DocumentCost::default();
        for cost in &self.costs[start..start + count] {
            shape.add(cost);
        }
        let bytes = shape.bytes.saturating_add(self.growth_bytes(count, &shape));
        self.guard
            .reserve_if_unchanged(reserved_before, bytes)
            .then_some(ProjectedGroup {
                guard: Some(self.guard),
                bytes,
                count,
            })
    }

    fn reserve_fitting<'d>(
        &mut self,
        figures: &ProcessMemory,
        start: usize,
        end: usize,
        document_at: &impl Fn(usize) -> Option<&'d Map>,
    ) -> Option<ProjectedGroup<'a>> {
        loop {
            let reserved_before = self.guard.reserved_bytes();
            let count = self.fitting_count(figures, reserved_before, start, end, document_at);
            if count == 0 {
                return None;
            }
            if let Some(group) = self.reserve_if_unchanged(reserved_before, start, count) {
                return Some(group);
            }
        }
    }

    fn exceeds_memory(&self, bound: u64, block_bytes: u64) -> NarsilError {
        let index_name = &self.index.name;
        NarsilError::new(
            ErrorCode::MEMORY_WRITE_BLOCKED,
            format!(
                "The engine refuses this document for index '{index_name}' because indexing it can take up to {bound} bytes, more than the {block_bytes} bytes that the engine allows its memory even when idle. Split the document into smaller documents."
            ),
        )
        .with_details([
            ("reason", Value::from(WRITE_EXCEEDS_MEMORY_REASON)),
            ("indexName", Value::from(index_name.as_str())),
            ("documentBytes", number(bound)),
            ("blockBytes", number(block_bytes)),
        ])
    }

    fn would_fill_memory(
        &self,
        bound: u64,
        figures: &ProcessMemory,
        collected: bool,
    ) -> NarsilError {
        let index_name = &self.index.name;
        let projected = self.guard.reserved_bytes();
        NarsilError::new(
            ErrorCode::MEMORY_WRITE_BLOCKED,
            format!(
                "The engine refuses this document for index '{index_name}' because indexing it can take up to {bound} bytes, which with the {projected} bytes that writes in progress can take would pass the engine's memory block. Retry once the writes in progress finish, or remove documents to free memory."
            ),
        )
        .with_details([
            ("reason", Value::from(WRITE_WOULD_FILL_MEMORY_REASON)),
            ("indexName", Value::from(index_name.as_str())),
            ("documentBytes", number(bound)),
            ("projectedBytes", number(projected)),
            ("heapBytes", Value::Null),
            ("youngHeapBytes", Value::Null),
            ("heapBytesBeforeCollection", Value::Null),
            ("collectedGarbage", Value::Bool(collected)),
            ("processBytes", number(figures.process_bytes)),
            ("youngCeilingBytes", Value::Null),
            ("youngReserveBytes", Value::Null),
            ("blockBytes", number(block_bytes_of(self.guard, figures))),
        ])
    }

    pub(crate) fn take_group<'d>(
        &mut self,
        start: usize,
        most: usize,
        document_at: impl Fn(usize) -> Option<&'d Map>,
    ) -> Result<ProjectedGroup<'a>, NarsilError> {
        let end = self.costs.len().min(start.saturating_add(most));
        if start >= end {
            return Ok(ProjectedGroup {
                guard: None,
                bytes: 0,
                count: 0,
            });
        }
        let Some(measured) = self.guard.write_figures() else {
            return Ok(ProjectedGroup {
                guard: None,
                bytes: 0,
                count: end - start,
            });
        };
        let block_bytes = block_bytes_of(self.guard, &measured);
        if self.costs[start].bytes > block_bytes {
            self.count_exactly(start, document_at(start));
        }
        if self.costs[start].bytes > block_bytes {
            return Err(self.exceeds_memory(self.costs[start].bytes, block_bytes));
        }
        if let Some(group) = self.reserve_fitting(&measured, start, end, &document_at) {
            return Ok(group);
        }
        let releases_before = self.guard.releases();
        let figures = self.guard.measure_after_release().unwrap_or(measured);
        if let Some(group) = self.reserve_fitting(&figures, start, end, &document_at) {
            return Ok(group);
        }
        let collected = self.guard.releases() != releases_before;
        if collected {
            self.guard.refused_after_release(&figures);
        }
        Err(self.would_fill_memory(self.costs[start].bytes, &figures, collected))
    }
}
