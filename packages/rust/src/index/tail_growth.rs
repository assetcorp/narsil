use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

use super::constants::CLONED_TREE_ENTRY_BYTES;
use super::partition::{Partition, PartitionSnapshot};
use super::segment::SegmentData;
use super::tail::TailSegment;
use crate::keyword::growing::{GrowingSegment, KeywordAdditions};

const HASH_TABLE_CONTROL_BYTES: usize = 1;
const HASH_TABLE_LOAD_NUMERATOR: usize = 8;
const HASH_TABLE_LOAD_DENOMINATOR: usize = 7;
const SNAPSHOT_HOLDERS_WITHOUT_READERS: usize = 2;

fn list_growth_bytes<T>(values: &Vec<T>, added: usize, copied: bool) -> usize {
    let capacity = match copied {
        true => values.len(),
        false => values.capacity(),
    };
    let needed = values.len().saturating_add(added);
    if needed <= capacity {
        return 0;
    }
    needed
        .max(capacity.saturating_mul(2))
        .saturating_mul(size_of::<T>())
}

fn table_bytes<K, V>(entries: usize) -> usize {
    (entries.saturating_mul(HASH_TABLE_LOAD_NUMERATOR) / HASH_TABLE_LOAD_DENOMINATOR)
        .checked_next_power_of_two()
        .unwrap_or(usize::MAX)
        .saturating_mul(size_of::<(K, V)>() + HASH_TABLE_CONTROL_BYTES)
}

fn table_growth_bytes<K, V>(table: &HashMap<K, V>, added: usize) -> usize {
    let needed = table.len().saturating_add(added);
    if needed <= table.capacity() {
        return 0;
    }
    table_bytes::<K, V>(needed)
}

fn empty_tail_bytes() -> usize {
    static BYTES: OnceLock<usize> = OnceLock::new();
    *BYTES.get_or_init(|| GrowingSegment::new(true).bytes())
}

pub(crate) fn snapshot_is_shared(snapshot: &Arc<PartitionSnapshot>) -> bool {
    Arc::strong_count(snapshot) > SNAPSHOT_HOLDERS_WITHOUT_READERS
}

impl TailSegment {
    fn growth_bytes(
        &self,
        documents: usize,
        values: usize,
        keyword: KeywordAdditions,
        copied: bool,
    ) -> usize {
        let columns = &self.columns;
        let mut bytes = list_growth_bytes(&self.ids, documents, copied)
            .saturating_add(table_growth_bytes(&self.id_lookup, documents))
            .saturating_add(list_growth_bytes(&self.documents, documents, copied));
        let listed = columns
            .numeric
            .values()
            .chain(columns.sizes.values())
            .map(|column| list_growth_bytes(column, values, copied))
            .chain(
                columns
                    .geopoints
                    .values()
                    .map(|column| list_growth_bytes(column, values, copied)),
            )
            .chain(
                columns
                    .patterns
                    .values()
                    .map(|column| list_growth_bytes(column, values, copied)),
            )
            .chain(columns.booleans.values().map(|(held, absent)| {
                list_growth_bytes(held, values, copied)
                    .saturating_add(list_growth_bytes(absent, values, copied))
            }));
        for column in listed {
            bytes = bytes.saturating_add(column);
        }
        let keyword = KeywordAdditions {
            ordinals: self.len().saturating_add(documents),
            ..keyword
        };
        bytes
            .saturating_add(self.keyword.growth_bytes(&keyword))
            .saturating_add(self.derived.copied_bytes(copied))
    }

    pub(crate) fn copy_bytes(&self) -> usize {
        let columns = &self.columns;
        let paths = columns
            .numeric
            .keys()
            .chain(columns.sizes.keys())
            .chain(columns.booleans.keys())
            .chain(columns.enums.keys())
            .chain(columns.geopoints.keys())
            .chain(columns.patterns.keys());
        let path_bytes = paths.fold(0usize, |bytes, path| {
            bytes
                .saturating_add(CLONED_TREE_ENTRY_BYTES)
                .saturating_add(path.len())
        });
        let name_bytes = self.field_names.iter().fold(0usize, |bytes, name| {
            bytes
                .saturating_add(size_of::<String>())
                .saturating_add(name.len().saturating_mul(2))
        });
        self.entry_bytes
            .saturating_add(self.keyword.bytes())
            .saturating_add(table_bytes::<String, u32>(self.id_lookup.capacity()))
            .saturating_add(table_bytes::<String, u16>(self.field_slots.capacity()))
            .saturating_add(size_of_val(self.name_ranks()))
            .saturating_add(name_bytes)
            .saturating_add(path_bytes)
    }
}

pub(crate) fn tail_growth_bytes(
    partition: &Partition,
    documents: usize,
    values: usize,
    keyword: KeywordAdditions,
    copies_last_tail: bool,
) -> usize {
    let snapshot = partition.snapshot();
    let shared = snapshot_is_shared(&snapshot);
    let growth = match snapshot.segments.last().map(|entry| &entry.data) {
        Some(SegmentData::Tail(tail)) if !shared && Arc::strong_count(tail) == 1 => {
            tail.growth_bytes(documents, values, keyword, false)
        }
        Some(SegmentData::Tail(tail)) if copies_last_tail => tail
            .growth_bytes(documents, values, keyword, true)
            .max(empty_tail_bytes()),
        _ => empty_tail_bytes(),
    };
    drop(snapshot);
    growth
}
