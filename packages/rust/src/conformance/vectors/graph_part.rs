use super::{Written, checkpoint_header, require_disk_keys, storage_is_disk, storage_value};
use crate::conformance::forms::{
    form_error, header_form, header_from_form, list, numbers_form, object, u8s, u32_of,
};
use crate::error::Result;
use crate::format::envelope::{Expectation, open_checksummed, pack};
use crate::format::graph_part::{
    GRAPH_PART_ENVELOPE_VERSION, NumberedGraph, decode_graph_part, encode_graph_part,
};
use crate::util::bytes::u32_bytes;
use crate::value::{Map, Value, encode_value};

fn neighbours_form(graph: &NumberedGraph) -> Result<Value> {
    let values = &graph.neighbours;
    let mut nodes = Vec::new();
    let mut cursor = 0usize;
    for &level in &graph.levels {
        if level == 0 {
            continue;
        }
        let mut layers = Vec::with_capacity(level as usize);
        for _ in 0..level {
            let short = || form_error("the graph ends inside a node's neighbour lists");
            let count = *values.get(cursor).ok_or_else(short)? as usize;
            let end = cursor
                .checked_add(1)
                .and_then(|start| start.checked_add(count))
                .ok_or_else(short)?;
            let layer = values.get(cursor + 1..end).ok_or_else(short)?;
            layers.push(numbers_form(layer));
            cursor = end;
        }
        nodes.push(Value::Array(layers));
    }
    if cursor != values.len() {
        return Err(form_error(
            "the graph holds neighbour values after the last node's lists",
        ));
    }
    Ok(Value::Array(nodes))
}

fn graph_form(graph: &NumberedGraph) -> Result<Value> {
    let mut map = Map::new();
    map.insert(
        "entryPoint",
        graph
            .entry_point
            .map_or(Value::Null, |entry| Value::Number(f64::from(entry))),
    );
    map.insert("maxLayer", Value::Number(f64::from(graph.max_layer)));
    map.insert("m", Value::Number(f64::from(graph.m)));
    map.insert(
        "efConstruction",
        Value::Number(f64::from(graph.ef_construction)),
    );
    map.insert("metric", Value::String(graph.metric.name().to_string()));
    if let Some(count) = graph.shuffled_build_count {
        map.insert("shuffledBuildCount", Value::Number(f64::from(count)));
    }
    if let Some(length) = graph.calibrated_mean_length {
        map.insert("calibratedMeanLength", Value::Number(length));
    }
    map.insert("levels", numbers_form(&graph.levels));
    map.insert("neighbours", neighbours_form(graph)?);
    Ok(Value::Object(map))
}

pub(crate) fn read_graph_part(bytes: &[u8], storage: Option<&str>) -> Result<Value> {
    let disk = storage_is_disk(storage)?;
    let expected = Expectation {
        version: GRAPH_PART_ENVELOPE_VERSION,
        what: "graph part",
        allows_compression: true,
    };
    let (header, payload) = open_checksummed(bytes, &expected)?;
    let part = decode_graph_part(payload.bytes())?;
    require_disk_keys(payload.bytes(), disk, &["head"])?;
    let mut body = Map::new();
    body.insert("v", Value::Number(2.0));
    body.insert("fieldName", Value::String(part.field_name.clone()));
    body.insert(
        "graphs",
        Value::Array(
            part.graphs
                .iter()
                .map(graph_form)
                .collect::<Result<Vec<_>>>()?,
        ),
    );
    let mut form = Map::new();
    form.insert("header", header_form(&header));
    form.insert("storage", storage_value(disk));
    form.insert("payload", Value::Object(body));
    Ok(Value::Object(form))
}

fn neighbour_bytes(levels: &[u8], nodes: &[Value]) -> Result<Vec<u8>> {
    let mut values = Vec::new();
    let mut node = 0usize;
    for &level in levels {
        if level == 0 {
            continue;
        }
        let what = format!("neighbours[{node}]");
        let layers = list(nodes.get(node), &what)?;
        if layers.len() != level as usize {
            return Err(form_error(format!(
                "{what} holds {} layers for level {level}",
                layers.len()
            )));
        }
        for (layer, ids) in layers.iter().enumerate() {
            let ids = list(Some(ids), &format!("{what}[{layer}]"))?;
            values.push(ids.len() as u32);
            for (at, id) in ids.iter().enumerate() {
                values.push(u32_of(Some(id), &format!("{what}[{layer}][{at}]"))?);
            }
        }
        node += 1;
    }
    if node != nodes.len() {
        return Err(form_error(format!(
            "neighbours holds {} nodes where levels give {node}",
            nodes.len()
        )));
    }
    Ok(u32_bytes(&values))
}

fn graph_raw(graph: &Map) -> Result<Value> {
    let mut raw = Map::new();
    for (key, value) in graph.iter() {
        if key != "levels" && key != "neighbours" {
            raw.insert(key.clone(), value.clone());
        }
    }
    let levels = u8s(graph.get("levels"), "levels")?;
    let neighbours = neighbour_bytes(&levels, list(graph.get("neighbours"), "neighbours")?)?;
    raw.insert("levels", Value::Bytes(levels));
    raw.insert("neighbours", Value::Bytes(neighbours));
    Ok(Value::Object(raw))
}

pub(crate) fn write_graph_part(form: &Map, storage: Option<&str>) -> Result<Written> {
    let disk = storage_is_disk(storage)?;
    let header = if disk {
        checkpoint_header(form, GRAPH_PART_ENVELOPE_VERSION, "graph part")?
    } else {
        header_from_form(form)?
    };
    if !header.checksum {
        return Err(form_error("a graph part carries a checksum"));
    }
    let payload = object(form.get("payload"), "payload")?;
    let mut raw = Map::new();
    for (key, value) in payload.iter() {
        let value = if key == "graphs" {
            let graphs = list(Some(value), "payload.graphs")?;
            Value::Array(
                graphs
                    .iter()
                    .map(|graph| graph_raw(object(Some(graph), "payload.graphs[]")?))
                    .collect::<Result<Vec<_>>>()?,
            )
        } else {
            value.clone()
        };
        raw.insert(key.clone(), value);
    }
    let part = decode_graph_part(&encode_value(&Value::Object(raw))?)?;
    let (payload, head) = encode_graph_part(&part, disk)?;
    let bytes = pack(&payload, header.version, header.compression, "graph part")?;
    Ok((bytes, head))
}
