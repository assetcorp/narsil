use std::mem::size_of;

use crate::format::keyword_segment::KeywordSegment;
use crate::index::partition::PartitionSnapshot;
use crate::index::segment::{SegmentData, SegmentEntry};
use crate::index::tail::TailSegment;
use crate::value::{Map, Value};

fn array_bytes<T>(items: &Vec<T>) -> usize {
    items.capacity().saturating_mul(size_of::<T>())
}

fn text_bytes(text: &str) -> usize {
    size_of::<String>().saturating_add(text.len())
}

fn texts_bytes(texts: &Vec<String>) -> usize {
    texts.iter().fold(array_bytes(texts), |total, text| {
        total.saturating_add(text.len())
    })
}

/// Returns the heap bytes of a stored document, walking it with an explicit stack so that a deeply nested document
/// costs no recursion.
pub(crate) fn document_bytes(document: &Map) -> usize {
    let mut total = size_of::<Map>();
    let mut pending: Vec<&Value> = Vec::new();
    for (key, value) in document.iter() {
        total = total.saturating_add(text_bytes(key));
        pending.push(value);
    }
    while let Some(value) = pending.pop() {
        total = total.saturating_add(size_of::<Value>());
        match value {
            Value::String(text) => total = total.saturating_add(text.len()),
            Value::Bytes(bytes) => total = total.saturating_add(bytes.len()),
            Value::Array(items) => pending.extend(items.iter()),
            Value::Object(map) => {
                for (key, child) in map.iter() {
                    total = total.saturating_add(text_bytes(key));
                    pending.push(child);
                }
            }
            Value::Null | Value::Bool(_) | Value::Number(_) | Value::Timestamp(_) => {}
        }
    }
    total
}

fn column_bytes(payload: &KeywordSegment) -> usize {
    let lengths = payload
        .field_lengths
        .iter()
        .map(|column| text_bytes(&column.field).saturating_add(array_bytes(&column.lengths)));
    let values = payload.numeric.iter().chain(&payload.sizes).map(|column| {
        text_bytes(&column.field)
            .saturating_add(array_bytes(&column.documents))
            .saturating_add(array_bytes(&column.values))
    });
    let booleans = payload.boolean.iter().map(|column| {
        text_bytes(&column.field)
            .saturating_add(array_bytes(&column.true_documents))
            .saturating_add(array_bytes(&column.false_documents))
    });
    let enums = payload.enums.iter().map(|column| {
        text_bytes(&column.field)
            .saturating_add(texts_bytes(&column.values))
            .saturating_add(array_bytes(&column.offsets))
            .saturating_add(array_bytes(&column.documents))
    });
    let geopoints = payload.geopoint.iter().map(|column| {
        text_bytes(&column.field)
            .saturating_add(array_bytes(&column.documents))
            .saturating_add(array_bytes(&column.latitudes))
            .saturating_add(array_bytes(&column.longitudes))
    });
    let patterns = payload.pattern.iter().map(|column| {
        text_bytes(&column.field)
            .saturating_add(array_bytes(&column.documents))
            .saturating_add(array_bytes(&column.runs))
            .saturating_add(array_bytes(&column.offsets))
            .saturating_add(array_bytes(&column.postings))
    });
    lengths
        .chain(values)
        .chain(booleans)
        .chain(enums)
        .chain(geopoints)
        .chain(patterns)
        .fold(0, usize::saturating_add)
}

fn payload_bytes(payload: &KeywordSegment) -> usize {
    let arrays = [
        array_bytes(&payload.ids),
        array_bytes(&payload.id_offsets),
        array_bytes(&payload.id_order),
        array_bytes(&payload.documents),
        array_bytes(&payload.document_offsets),
        texts_bytes(&payload.field_names),
        texts_bytes(&payload.tombstones),
        array_bytes(&payload.tokens),
        array_bytes(&payload.token_offsets),
        array_bytes(&payload.document_frequencies),
        array_bytes(&payload.posting_offsets),
        array_bytes(&payload.posting_documents),
        array_bytes(&payload.posting_frequencies),
        array_bytes(&payload.posting_fields),
        payload.positions.as_ref().map_or(0, |positions| {
            array_bytes(&positions.offsets).saturating_add(array_bytes(&positions.values))
        }),
        payload.surface_forms.as_ref().map_or(0, |forms| {
            array_bytes(&forms.text)
                .saturating_add(array_bytes(&forms.offsets))
                .saturating_add(array_bytes(&forms.counts))
        }),
        payload.partial_words.as_ref().map_or(0, |words| {
            texts_bytes(&words.fields)
                .saturating_add(array_bytes(&words.text))
                .saturating_add(array_bytes(&words.offsets))
                .saturating_add(array_bytes(&words.tokens))
                .saturating_add(array_bytes(&words.counts))
                .saturating_add(array_bytes(&words.runs))
                .saturating_add(array_bytes(&words.run_offsets))
                .saturating_add(array_bytes(&words.run_entries))
        }),
        payload.write_records.as_ref().map_or(0, |records| {
            array_bytes(&records.seq_nos).saturating_add(array_bytes(&records.primary_terms))
        }),
        column_bytes(payload),
    ];
    arrays.into_iter().fold(0, usize::saturating_add)
}

fn tail_bytes(tail: &TailSegment) -> usize {
    let ids = texts_bytes(&tail.ids).saturating_add(tail.id_lookup.iter().fold(
        0usize,
        |total, (id, _)| {
            total
                .saturating_add(text_bytes(id))
                .saturating_add(size_of::<u32>())
        },
    ));
    let documents = tail
        .documents
        .iter()
        .fold(array_bytes(&tail.documents), |total, document| {
            total.saturating_add(document_bytes(document))
        });
    [
        ids,
        documents,
        tail.keyword.bytes(),
        texts_bytes(&tail.field_names),
    ]
    .into_iter()
    .fold(0, usize::saturating_add)
}

fn segment_bytes(entry: &SegmentEntry) -> usize {
    let held = match &entry.data {
        SegmentData::Frozen(segment) => {
            payload_bytes(&segment.payload).saturating_add(segment.view.bytes())
        }
        SegmentData::Tail(tail) => tail_bytes(tail),
    };
    held.saturating_add(entry.state.as_ref().map_or(0, |state| state.bytes()))
}

/// Returns an estimate of the heap bytes that one partition's segments hold: the documents, IDs, terms, postings,
/// positions, and value columns that are in memory, leaving out the sections that a paged segment reads from its
/// file.
pub(crate) fn partition_bytes(snapshot: &PartitionSnapshot) -> u64 {
    let total = snapshot
        .segments
        .iter()
        .map(segment_bytes)
        .fold(0, usize::saturating_add);
    u64::try_from(total).unwrap_or(u64::MAX)
}
