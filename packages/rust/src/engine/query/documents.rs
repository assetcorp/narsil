use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::Arc;

use crate::engine::index::IndexState;
use crate::engine::layout::TextLayout;
use crate::error::Result;
use crate::index::partition::PartitionSnapshot;
use crate::index::segment::{SegmentData, SegmentEntry};
use crate::index::stored_values::{FieldColumn, path_value};
use crate::index::tail::TailSegment;
use crate::pins::Pin;
use crate::value::{Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct Location {
    pub(crate) partition: u32,
    pub(crate) segment: u32,
    pub(crate) ordinal: u32,
}

pub(crate) struct QuerySnapshots {
    pub(crate) layout: Arc<TextLayout>,
    pub(crate) partitions: Vec<Arc<PartitionSnapshot>>,
    pub(crate) pin: Pin,
}

impl QuerySnapshots {
    pub(crate) fn of(index: &IndexState) -> Result<QuerySnapshots> {
        let pin = index.vectors.sequence().pin()?;
        let layout = index.partitions();
        let partitions = layout
            .iter()
            .map(|partition| partition.snapshot())
            .collect();
        Ok(QuerySnapshots {
            layout,
            partitions,
            pin,
        })
    }

    fn located_in(&self, partition: usize, id: &str) -> Result<Option<Location>> {
        let Some(snapshot) = self.partitions.get(partition) else {
            return Ok(None);
        };
        Ok(snapshot.locate(id)?.map(|(segment, ordinal)| Location {
            partition: partition as u32,
            segment: segment as u32,
            ordinal,
        }))
    }

    pub(crate) fn locate(&self, index: &IndexState, id: &str) -> Result<Option<Location>> {
        let routed = index.route(id, self.partitions.len());
        if let Some(location) = self.located_in(routed, id)? {
            return Ok(Some(location));
        }
        for partition in 0..self.partitions.len() {
            if partition == routed {
                continue;
            }
            if let Some(location) = self.located_in(partition, id)? {
                return Ok(Some(location));
            }
        }
        Ok(None)
    }

    pub(crate) fn entry(&self, location: Location) -> Option<&SegmentEntry> {
        self.partitions
            .get(location.partition as usize)?
            .segments
            .get(location.segment as usize)
    }

    pub(crate) fn document(
        &self,
        index: &IndexState,
        id: &str,
        location: Option<Location>,
    ) -> Result<Option<Arc<Map>>> {
        let location = match location {
            Some(location) => Some(location),
            None => self.locate(index, id)?,
        };
        let stored =
            match location.and_then(|location| Some((self.entry(location)?, location.ordinal))) {
                Some((entry, ordinal)) => entry.document(ordinal)?,
                None => return Ok(None),
            };
        if index.vectors.is_empty() {
            return Ok(Some(stored));
        }
        let mut document = Arc::unwrap_or_clone(stored);
        let vectors = index.vectors.pinned_vectors(id, self.pin.value())?;
        index.vectors.attach(vectors, &mut document);
        Ok(Some(Arc::new(document)))
    }
}

pub(crate) enum FieldReader {
    Column(FieldColumn),
    Tail {
        tail: Arc<TailSegment>,
        path: String,
    },
}

impl FieldReader {
    pub(crate) fn of(entry: &SegmentEntry, path: &str) -> Result<FieldReader> {
        Ok(match &entry.data {
            SegmentData::Frozen(segment) => FieldReader::Column(segment.field_column(path)?),
            SegmentData::Tail(tail) => FieldReader::Tail {
                tail: tail.clone(),
                path: path.to_string(),
            },
        })
    }

    pub(crate) fn get(&self, ordinal: u32) -> Option<Cow<'_, Value>> {
        match self {
            FieldReader::Column(column) => {
                column.get(ordinal as usize)?.as_ref().map(Cow::Borrowed)
            }
            FieldReader::Tail { tail, path } => {
                path_value(tail.documents.get(ordinal as usize)?, path)
            }
        }
    }
}

pub(crate) struct LocatedFields {
    readers: Vec<Vec<FieldReader>>,
    slots: HashMap<(u32, u32), usize>,
}

impl LocatedFields {
    pub(crate) fn of(
        snapshots: &QuerySnapshots,
        locations: impl Iterator<Item = Location>,
        paths: &[&str],
    ) -> Result<LocatedFields> {
        let mut located = LocatedFields {
            readers: Vec::new(),
            slots: HashMap::new(),
        };
        for location in locations {
            let slot = (location.partition, location.segment);
            if located.slots.contains_key(&slot) {
                continue;
            }
            let Some(entry) = snapshots.entry(location) else {
                continue;
            };
            let readers = paths
                .iter()
                .map(|path| FieldReader::of(entry, path))
                .collect::<Result<Vec<FieldReader>>>()?;
            located.slots.insert(slot, located.readers.len());
            located.readers.push(readers);
        }
        Ok(located)
    }

    pub(crate) fn readers(&self, location: Location) -> Option<&[FieldReader]> {
        let at = *self.slots.get(&(location.partition, location.segment))?;
        self.readers.get(at).map(Vec::as_slice)
    }
}

pub(crate) fn matched_ordinals(words: &[u32]) -> impl Iterator<Item = u32> + '_ {
    words.iter().enumerate().flat_map(|(at, &word)| {
        let base = (at as u32) << 5;
        let mut remaining = word;
        std::iter::from_fn(move || {
            if remaining == 0 {
                return None;
            }
            let bit = remaining.trailing_zeros();
            remaining &= remaining - 1;
            Some(base + bit)
        })
    })
}
