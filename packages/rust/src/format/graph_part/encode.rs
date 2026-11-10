use super::{GraphPart, NumberedGraph, VECTOR_GRAPH_PART_PAYLOAD_VERSION};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::file_sections::{
    FileSection, PayloadBuilder, RECORD_PAGE_BYTES, SEGMENT_PAGE_BYTES,
};
use crate::format::manifest_refs::Head;
use crate::util::bytes::u32_bytes;
use crate::value::{
    write_array_header, write_binary, write_map_header, write_nil, write_number, write_string,
    write_uint,
};

const MEMORY_KEYS: usize = 3;
const DISK_KEYS: usize = 4;
const BYTE_KEYS: usize = 2;
const HEAD_LAYOUT_EXTRA_KEYS: usize = 3;

fn header_entries(graph: &NumberedGraph) -> usize {
    5 + usize::from(graph.shuffled_build_count.is_some())
        + usize::from(graph.calibrated_mean_length.is_some())
}

fn write_header_entries(out: &mut Vec<u8>, graph: &NumberedGraph) {
    write_string(out, "entryPoint");
    match graph.entry_point {
        Some(entry_point) => write_uint(out, u64::from(entry_point)),
        None => write_nil(out),
    }
    write_string(out, "maxLayer");
    write_uint(out, u64::from(graph.max_layer));
    write_string(out, "m");
    write_uint(out, u64::from(graph.m));
    write_string(out, "efConstruction");
    write_uint(out, u64::from(graph.ef_construction));
    write_string(out, "metric");
    write_string(out, graph.metric.name());
}

fn write_build_entries(out: &mut Vec<u8>, graph: &NumberedGraph) {
    if let Some(count) = graph.shuffled_build_count {
        write_string(out, "shuffledBuildCount");
        write_uint(out, u64::from(count));
    }
    if let Some(length) = graph.calibrated_mean_length {
        write_string(out, "calibratedMeanLength");
        write_number(out, length);
    }
}

fn write_leading_entries(builder: &mut PayloadBuilder, part: &GraphPart, keys: usize) {
    write_map_header(&mut builder.bytes, keys);
    builder.key("v");
    write_uint(
        &mut builder.bytes,
        u64::from(VECTOR_GRAPH_PART_PAYLOAD_VERSION),
    );
    builder.key("fieldName");
    write_string(&mut builder.bytes, &part.field_name);
    builder.key("graphs");
    write_array_header(&mut builder.bytes, part.graphs.len());
}

fn encode_memory_part(part: &GraphPart) -> Vec<u8> {
    let mut builder = PayloadBuilder::with_capacity(
        part.graphs
            .iter()
            .map(|graph| graph.neighbours.len() * 4 + graph.levels.len() + 128)
            .sum(),
    );
    write_leading_entries(&mut builder, part, MEMORY_KEYS);
    for graph in &part.graphs {
        write_map_header(&mut builder.bytes, header_entries(graph) + BYTE_KEYS);
        write_header_entries(&mut builder.bytes, graph);
        builder.bytes_entry("levels", &graph.levels);
        builder.bytes_entry("neighbours", &u32_bytes(&graph.neighbours));
        write_build_entries(&mut builder.bytes, graph);
    }
    builder.bytes
}

fn node_offsets(graph: &NumberedGraph) -> Result<Vec<u32>> {
    let mut offsets = Vec::with_capacity(graph.levels.len() + 1);
    let mut cursor = 0usize;
    for &level in &graph.levels {
        offsets.push((cursor * 4) as u32);
        for _ in 0..level {
            let Some(&count) = graph.neighbours.get(cursor) else {
                return Err(save_failed());
            };
            cursor += count as usize + 1;
        }
    }
    if cursor > graph.neighbours.len() {
        return Err(save_failed());
    }
    offsets.push((cursor * 4) as u32);
    Ok(offsets)
}

fn save_failed() -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_SAVE_FAILED,
        "A graph part holds neighbour lists that end inside a list",
    )
}

fn encode_disk_part(part: &GraphPart) -> Result<(Vec<u8>, Head)> {
    let mut builder = PayloadBuilder::with_capacity(
        part.graphs
            .iter()
            .map(|graph| graph.neighbours.len() * 4 + graph.levels.len() * 5 + 256)
            .sum(),
    );
    write_leading_entries(&mut builder, part, DISK_KEYS);
    let mut head = Vec::new();
    write_map_header(&mut head, 1);
    write_string(&mut head, "graphs");
    write_array_header(&mut head, part.graphs.len());
    for graph in &part.graphs {
        write_map_header(&mut builder.bytes, header_entries(graph) + BYTE_KEYS);
        write_header_entries(&mut builder.bytes, graph);
        write_build_entries(&mut builder.bytes, graph);
        let levels_at = builder.bytes_entry("levels", &graph.levels);
        let neighbours = u32_bytes(&graph.neighbours);
        let neighbours_at = builder.bytes_entry("neighbours", &neighbours);
        write_map_header(&mut head, header_entries(graph) + HEAD_LAYOUT_EXTRA_KEYS);
        write_header_entries(&mut head, graph);
        write_build_entries(&mut head, graph);
        write_string(&mut head, "levels");
        FileSection::of("levels", levels_at, &graph.levels, SEGMENT_PAGE_BYTES).write(&mut head);
        write_string(&mut head, "nodeOffsets");
        write_binary(&mut head, &u32_bytes(&node_offsets(graph)?));
        write_string(&mut head, "neighbours");
        FileSection::of("neighbours", neighbours_at, &neighbours, RECORD_PAGE_BYTES)
            .write(&mut head);
    }
    let head_ref = builder.head_entry(&head);
    Ok((builder.bytes, head_ref))
}

/// Writes a graph part payload, and for a disk field the head that lets a reader page its lists in.
pub(crate) fn encode_graph_part(part: &GraphPart, disk: bool) -> Result<(Vec<u8>, Option<Head>)> {
    for graph in &part.graphs {
        node_offsets(graph)?;
    }
    if !disk {
        return Ok((encode_memory_part(part), None));
    }
    encode_disk_part(part).map(|(bytes, head)| (bytes, Some(head)))
}
