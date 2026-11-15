use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

use super::partition::Partition;
use super::segment::SegmentData;
use super::tail::TailSegment;
use crate::keyword::growing::{GrowingSegment, KeywordAdditions};

const HASH_TABLE_CONTROL_BYTES: usize = 1;
const HASH_TABLE_LOAD_NUMERATOR: usize = 8;
const HASH_TABLE_LOAD_DENOMINATOR: usize = 7;
const SNAPSHOT_HOLDERS_WITHOUT_READERS: usize = 2;

fn list_growth_bytes<T>(values: &Vec<T>, added: usize) -> usize {
    let needed = values.len().saturating_add(added);
    if needed <= values.capacity() {
        return 0;
    }
    needed
        .max(values.capacity().saturating_mul(2))
        .saturating_mul(size_of::<T>())
}

fn table_growth_bytes<K, V>(table: &HashMap<K, V>, added: usize) -> usize {
    let needed = table.len().saturating_add(added);
    if needed <= table.capacity() {
        return 0;
    }
    (needed.saturating_mul(HASH_TABLE_LOAD_NUMERATOR) / HASH_TABLE_LOAD_DENOMINATOR)
        .checked_next_power_of_two()
        .unwrap_or(usize::MAX)
        .saturating_mul(size_of::<(K, V)>() + HASH_TABLE_CONTROL_BYTES)
}

fn empty_tail_bytes() -> usize {
    static BYTES: OnceLock<usize> = OnceLock::new();
    *BYTES.get_or_init(|| GrowingSegment::new(true).bytes())
}

impl TailSegment {
    fn growth_bytes(&self, documents: usize, values: usize, keyword: KeywordAdditions) -> usize {
        let columns = &self.columns;
        let mut bytes = list_growth_bytes(&self.ids, documents)
            .saturating_add(table_growth_bytes(&self.id_lookup, documents))
            .saturating_add(list_growth_bytes(&self.documents, documents));
        let listed = columns
            .numeric
            .values()
            .chain(columns.sizes.values())
            .map(|column| list_growth_bytes(column, values))
            .chain(
                columns
                    .geopoints
                    .values()
                    .map(|column| list_growth_bytes(column, values)),
            )
            .chain(
                columns
                    .patterns
                    .values()
                    .map(|column| list_growth_bytes(column, values)),
            )
            .chain(columns.booleans.values().map(|(held, absent)| {
                list_growth_bytes(held, values).saturating_add(list_growth_bytes(absent, values))
            }));
        for column in listed {
            bytes = bytes.saturating_add(column);
        }
        let keyword = KeywordAdditions {
            ordinals: self.len().saturating_add(documents),
            ..keyword
        };
        bytes.saturating_add(self.keyword.growth_bytes(&keyword))
    }
}

pub(crate) fn tail_growth_bytes(
    partition: &Partition,
    documents: usize,
    values: usize,
    keyword: KeywordAdditions,
) -> usize {
    let snapshot = partition.snapshot();
    let shared = Arc::strong_count(&snapshot) > SNAPSHOT_HOLDERS_WITHOUT_READERS;
    let growth = match snapshot.segments.last().map(|entry| &entry.data) {
        Some(SegmentData::Tail(tail)) if !shared && Arc::strong_count(tail) == 1 => {
            tail.growth_bytes(documents, values, keyword)
        }
        _ => empty_tail_bytes(),
    };
    drop(snapshot);
    growth
}
