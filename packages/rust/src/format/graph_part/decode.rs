use super::{
    GRAPH_PREFIX, GraphPart, GraphParts, MAX_M, MIN_M, Metric, NumberedGraph, PART_PREFIX,
    VECTOR_GRAPH_PART_PAYLOAD_VERSION, VECTOR_GRAPH_PAYLOAD_VERSION,
};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::fields::{Fields, whole_number_up_to};
use crate::format::vector_file::require_payload_version;
use crate::util::bytes::u32_list;
use crate::value::{Value, decode_value};

fn ends_inside_a_list() -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_LOAD_FAILED,
        format!("{GRAPH_PREFIX}neighbours ends inside a list"),
    )
}

fn require_whole_neighbour_lists(levels: &[u8], values: &[u32]) -> Result<()> {
    let mut cursor = 0usize;
    for &level in levels {
        for _ in 0..level {
            let Some(&count) = values.get(cursor) else {
                return Err(ends_inside_a_list());
            };
            if count as usize > values.len() - cursor - 1 {
                return Err(ends_inside_a_list());
            }
            cursor += count as usize + 1;
        }
    }
    Ok(())
}

fn decode_graph(raw: &Value) -> Result<NumberedGraph> {
    let Value::Object(map) = raw else {
        return Err(NarsilError::new(
            ErrorCode::PERSISTENCE_LOAD_FAILED,
            format!("{GRAPH_PREFIX}each graph must be a map"),
        ));
    };
    let fields = Fields::new(map, ErrorCode::PERSISTENCE_LOAD_FAILED, GRAPH_PREFIX);
    let entry_point = match map.get("entryPoint") {
        None | Some(Value::Null) => None,
        found => match whole_number_up_to(found, f64::from(u32::MAX)) {
            Some(number) => Some(number as u32),
            None => return Err(fields.error("entryPoint must be a uint32 or nil")),
        },
    };
    let Some(max_layer) = whole_number_up_to(map.get("maxLayer"), f64::from(u8::MAX)) else {
        return Err(fields.error("maxLayer must be a uint8"));
    };
    let m = match whole_number_up_to(map.get("m"), f64::from(MAX_M)) {
        Some(m) if m >= f64::from(MIN_M) => m as u32,
        _ => {
            return Err(fields.error(format!("m must be a whole number from {MIN_M} to {MAX_M}")));
        }
    };
    let Some(ef_construction) = whole_number_up_to(map.get("efConstruction"), f64::from(u16::MAX))
    else {
        return Err(fields.error("efConstruction must be a uint16"));
    };
    let Some(metric) = (match map.get("metric") {
        Some(Value::String(name)) => Metric::parse(name),
        _ => None,
    }) else {
        return Err(fields.error("metric must name a supported metric"));
    };
    let Some(Value::Bytes(levels)) = map.get("levels") else {
        return Err(fields.error("levels must be bytes"));
    };
    let Some(Value::Bytes(neighbour_bytes)) = map.get("neighbours") else {
        return Err(fields.error("neighbours must be bytes"));
    };
    let calibrated_mean_length = match map.get("calibratedMeanLength") {
        None | Some(Value::Null) => None,
        Some(Value::Number(number)) if number.is_finite() && *number >= 0.0 => Some(*number),
        Some(_) => {
            return Err(fields.error("calibratedMeanLength must be a finite float64 of at least 0"));
        }
    };
    let shuffled_build_count = match map.get("shuffledBuildCount") {
        None | Some(Value::Null) => None,
        found => match whole_number_up_to(found, f64::from(u32::MAX)) {
            Some(number) => Some(number as u32),
            None => return Err(fields.error("shuffledBuildCount must be a uint32")),
        },
    };
    if neighbour_bytes.len() % 4 != 0 {
        return Err(ends_inside_a_list());
    }
    let neighbours = u32_list(neighbour_bytes, "neighbours")?;
    require_whole_neighbour_lists(levels, &neighbours)?;
    Ok(NumberedGraph {
        entry_point,
        max_layer: max_layer as u8,
        m,
        ef_construction: ef_construction as u16,
        metric,
        levels: levels.clone(),
        neighbours,
        calibrated_mean_length: shuffled_build_count.and(calibrated_mean_length),
        shuffled_build_count,
    })
}

fn decode_graphs_payload(
    payload: &[u8],
    name: &str,
    prefix: &str,
    version: u8,
) -> Result<GraphPart> {
    let raw = decode_value(payload)?;
    let Value::Object(map) = &raw else {
        return Err(NarsilError::new(
            ErrorCode::PERSISTENCE_LOAD_FAILED,
            format!("{prefix}payload must be a map"),
        ));
    };
    let fields = Fields::new(map, ErrorCode::PERSISTENCE_LOAD_FAILED, prefix);
    require_payload_version(name, map.get("v"), version)?;
    let field_name = fields.string("fieldName")?.to_string();
    let Some(Value::Array(graphs)) = map.get("graphs") else {
        return Err(fields.error("graphs must be a list"));
    };
    let graphs = graphs
        .iter()
        .map(decode_graph)
        .collect::<Result<Vec<_>>>()?;
    Ok(GraphPart { field_name, graphs })
}

/// Reads a graph part payload with the checks of the reference reader, in its order.
pub(crate) fn decode_graph_part(payload: &[u8]) -> Result<GraphPart> {
    decode_graphs_payload(
        payload,
        "vector graph part",
        PART_PREFIX,
        VECTOR_GRAPH_PART_PAYLOAD_VERSION,
    )
}

/// Reads the single-file graph payload that earlier releases wrote for a field.
pub(crate) fn decode_earlier_graph_payload(payload: &[u8]) -> Result<GraphParts> {
    let decoded = decode_graphs_payload(
        payload,
        "vector graph",
        GRAPH_PREFIX,
        VECTOR_GRAPH_PAYLOAD_VERSION,
    )?;
    Ok(GraphParts {
        field_name: decoded.field_name,
        part_size: decoded
            .graphs
            .iter()
            .map(|graph| graph.levels.len().max(1))
            .collect(),
        graphs: decoded
            .graphs
            .into_iter()
            .map(|graph| vec![graph])
            .collect(),
    })
}
