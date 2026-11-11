use crate::conformance::forms::form_error;
use crate::error::{Result, load_failed};
use crate::format::earlier_payload::{
    EarlierVectorField, EarlierVectorPart, V2Documents, decode_index_snapshot,
    decode_snapshot_bundle, decode_v2_documents, open_index_snapshot,
};
use crate::format::graph_part::{GraphParts, NumberedGraph};
use crate::format::metadata::open_lenient_envelope;
use crate::value::{Map, Value, decode_value};

const SNAPSHOT_ENVELOPE_VERSION: u8 = 2;

fn object(entries: Vec<(&str, Value)>) -> Value {
    let mut map = Map::with_capacity(entries.len());
    for (key, value) in entries {
        map.insert(key, value);
    }
    Value::Object(map)
}

fn number(value: impl Into<f64>) -> Value {
    Value::Number(value.into())
}

fn strings(values: &[String]) -> Value {
    Value::Array(values.iter().cloned().map(Value::String).collect())
}

fn numbers<T: Copy + Into<f64>>(values: &[T]) -> Value {
    Value::Array(values.iter().map(|&value| number(value)).collect())
}

fn documents_form(stored: V2Documents) -> Value {
    let documents = stored
        .documents
        .into_iter()
        .map(|(id, fields)| Value::Array(vec![Value::String(id), Value::Object(fields)]))
        .collect();
    object(vec![
        ("schema", Value::Object(stored.schema)),
        ("documents", Value::Array(documents)),
    ])
}

fn part_form(part: &EarlierVectorPart) -> Value {
    let vectors = part
        .vectors
        .chunks(part.dimension.max(1))
        .map(numbers)
        .collect();
    let codes = part.codes.as_ref().map_or(Value::Null, |codes| {
        object(vec![
            ("bits", number(codes.bits)),
            (
                "centroid",
                Value::Array(codes.centroid.iter().map(|&value| number(value)).collect()),
            ),
            ("recordBytes", number(codes.records.len() as f64)),
        ])
    });
    object(vec![
        ("fieldName", Value::String(part.field_name.clone())),
        ("dimension", number(part.dimension as f64)),
        ("part", number(part.part as f64)),
        ("parts", number(part.parts as f64)),
        ("docIds", strings(&part.doc_ids)),
        ("vectors", Value::Array(vectors)),
        ("codes", codes),
    ])
}

fn graph_form(graph: &NumberedGraph) -> Value {
    object(vec![
        ("entryPoint", graph.entry_point.map_or(Value::Null, number)),
        ("maxLayer", number(graph.max_layer)),
        ("m", number(graph.m)),
        ("efConstruction", number(graph.ef_construction)),
        ("metric", Value::String(graph.metric.name().to_string())),
        ("levels", numbers(&graph.levels)),
        ("neighbours", numbers(&graph.neighbours)),
    ])
}

fn graphs_form(graphs: &GraphParts) -> Value {
    Value::Array(graphs.graphs.iter().flatten().map(graph_form).collect())
}

fn field_form(field: &EarlierVectorField) -> Value {
    object(vec![
        (
            "parts",
            Value::Array(field.parts.iter().map(part_form).collect()),
        ),
        (
            "graphs",
            field.graph.as_ref().map_or(Value::Null, graphs_form),
        ),
    ])
}

fn read_segment_file(bytes: &[u8]) -> Result<Value> {
    let (_, payload) = open_lenient_envelope(bytes, SNAPSHOT_ENVELOPE_VERSION)?;
    let Value::Object(container) = decode_value(&payload)? else {
        return load_failed("Segment file is missing its partition payload");
    };
    let Some(Value::Bytes(partition)) = container.get("payload") else {
        return load_failed("Segment file is missing its partition payload");
    };
    let tombstones = match container.get("tombstones") {
        None => Value::Array(Vec::new()),
        Some(Value::Array(items)) if items.iter().all(|item| item.as_str().is_some()) => {
            Value::Array(items.clone())
        }
        Some(_) => return load_failed("Segment file has a malformed tombstone list"),
    };
    Ok(object(vec![
        ("partition", documents_form(decode_v2_documents(partition)?)),
        ("tombstones", tombstones),
    ]))
}

fn read_snapshot_bundle(bytes: &[u8]) -> Result<Value> {
    let (_, payload) = open_lenient_envelope(bytes, SNAPSHOT_ENVELOPE_VERSION)?;
    let bundle = decode_snapshot_bundle(&payload)?;
    let partitions = bundle
        .partitions
        .iter()
        .map(|partition| decode_v2_documents(partition).map(documents_form))
        .collect::<Result<Vec<_>>>()?;
    let mut fields = Map::new();
    for (path, field) in &bundle.vector_indexes {
        fields.insert(path.clone(), field_form(field));
    }
    let checkpoint = bundle
        .checkpoint
        .iter()
        .map(|entry| {
            object(vec![
                ("partitionId", number(entry.partition_id)),
                ("lastSeqNo", number(entry.last_seq_no as f64)),
                ("primaryTerm", number(entry.primary_term as f64)),
            ])
        })
        .collect();
    Ok(object(vec![
        ("schema", Value::Object(bundle.schema)),
        ("language", Value::String(bundle.language)),
        ("partitions", Value::Array(partitions)),
        ("vectorIndexes", Value::Object(fields)),
        ("checkpoint", Value::Array(checkpoint)),
    ]))
}

fn read_index_snapshot(bytes: &[u8]) -> Result<Value> {
    let snapshot = decode_index_snapshot(&open_index_snapshot(bytes)?)?;
    let mut fields = Map::new();
    for (path, parts) in &snapshot.vector_indexes {
        fields.insert(
            path.clone(),
            Value::Array(parts.iter().map(part_form).collect()),
        );
    }
    Ok(object(vec![
        ("settings", Value::Object(snapshot.settings)),
        ("schema", Value::Object(snapshot.schema)),
        ("language", Value::String(snapshot.language)),
        (
            "partitions",
            Value::Array(
                snapshot
                    .partitions
                    .into_iter()
                    .map(documents_form)
                    .collect(),
            ),
        ),
        ("vectorIndexes", Value::Object(fields)),
    ]))
}

pub(crate) fn read_earlier_file(layout: &str, bytes: &[u8]) -> Result<Value> {
    match layout {
        "segment-file" => read_segment_file(bytes),
        "snapshot-bundle" => read_snapshot_bundle(bytes),
        "index-snapshot" => read_index_snapshot(bytes),
        other => Err(form_error(format!(
            "this crate reads no earlier {other} file"
        ))),
    }
}
