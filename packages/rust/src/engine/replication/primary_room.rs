use super::PrimaryRefusal;
use super::primary_apply::Candidate;
use crate::engine::index::IndexState;
use crate::engine::memory::{MemoryGuard, ProjectedGroup, WriteProjection, refused_after};
use crate::value::Map;

type Checked = std::result::Result<Candidate, PrimaryRefusal>;

fn stored(checked: &Checked) -> Option<(&str, &Map)> {
    let candidate = checked.as_ref().ok()?;
    Some((candidate.id.as_str(), candidate.document.as_ref()?))
}

/// The memory that a primary reserves for its writes, a group of documents at a time, as a batch write does.
pub(super) struct PrimaryRoom<'a> {
    projection: WriteProjection<'a>,
    positions: Vec<usize>,
    next: usize,
    group_end: usize,
    group: Option<ProjectedGroup<'a>>,
    refused: Option<String>,
    index_name: &'a str,
}

impl<'a> PrimaryRoom<'a> {
    pub(super) fn new(
        memory: &'a MemoryGuard,
        index: &'a IndexState,
        writes: &[Option<Checked>],
    ) -> PrimaryRoom<'a> {
        let mut positions = Vec::with_capacity(writes.len());
        let mut replaces = false;
        for (at, checked) in writes.iter().enumerate() {
            if let Some(Ok(candidate)) = checked
                && candidate.document.is_some()
            {
                positions.push(at);
                replaces |= !candidate.inserts;
            }
        }
        let documents = || {
            positions
                .iter()
                .filter_map(|&at| writes.get(at)?.as_ref().and_then(stored))
        };
        let mut projection =
            WriteProjection::new(memory, index, documents().map(|(_, document)| document));
        if replaces {
            let replaced = documents().map(|(id, _)| id.to_string()).collect();
            projection = projection.replacing(replaced);
        }
        PrimaryRoom {
            projection,
            positions,
            next: 0,
            group_end: 0,
            group: None,
            refused: None,
            index_name: &index.name,
        }
    }

    /// Makes room for the write at `at` of `writes`, which holds until the call after the last write of its group.
    pub(super) fn reserve(
        &mut self,
        at: usize,
        writes: &[Option<Checked>],
    ) -> std::result::Result<(), PrimaryRefusal> {
        if self.positions.get(self.next) != Some(&at) {
            return Ok(());
        }
        let Some((id, _)) = writes.get(at).and_then(Option::as_ref).and_then(stored) else {
            return Ok(());
        };
        if let Some(first) = &self.refused {
            self.next += 1;
            return Err(refused_after(self.index_name, id, first).into());
        }
        if self.next == self.group_end {
            self.group = None;
            let positions = &self.positions;
            let taken = self
                .projection
                .take_group(self.next, positions.len(), |slot| {
                    let &position = positions.get(slot)?;
                    let (_, document) = writes.get(position)?.as_ref().and_then(stored)?;
                    Some(document)
                });
            match taken {
                Ok(group) => {
                    self.group_end = self.next + group.count.max(1);
                    self.group = Some(group);
                }
                Err(error) => {
                    self.refused = Some(id.to_string());
                    self.next += 1;
                    return Err(error.into());
                }
            }
        }
        self.next += 1;
        Ok(())
    }
}
