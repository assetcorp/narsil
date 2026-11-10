use crate::error::{Result, load_failed};
use crate::format::graph_part::VECTOR_GRAPH_PART_VECTORS;
use crate::format::vector_file::osq_record_bytes;
use crate::format::vector_head::{FileCodes, GraphPartLayout};

use super::super::constants::MAX_LAYER_CAP;
use super::field::{ColdFile, ColdGraph, ColdGraphPart};

const FLOAT32_BYTES: u64 = 4;

fn whole_number_within(value: f64, most: f64) -> Option<u32> {
    (value.fract() == 0.0 && value >= 0.0 && value <= most).then_some(value as u32)
}

pub(crate) fn require_matching_layout(
    dimension: usize,
    codes: Option<&FileCodes>,
    files: &[ColdFile],
) -> Result<u32> {
    if dimension == 0 || dimension > u32::MAX as usize {
        return load_failed("The disk vector field holds an invalid dimension");
    }
    if codes.is_some_and(|codes| {
        codes.centroid.len() != dimension || codes.centroid.iter().any(|value| !value.is_finite())
    }) {
        return load_failed("The disk vector field holds an invalid centroid");
    }
    let mut total = 0u32;
    for file in files {
        let count = u64::from(file.count);
        let matches_codes = codes.is_none_or(|codes| {
            file.sections.records.as_ref().is_some_and(|records| {
                records.length == count * osq_record_bytes(dimension, codes.bits) as u64
            })
        });
        let matches = file.count > 0
            && file.count <= u32::MAX - total
            && file.first == total
            && file.sections.vectors.length == count * dimension as u64 * FLOAT32_BYTES
            && file
                .dead
                .as_ref()
                .is_none_or(|dead| dead.len() as u64 == count.div_ceil(8))
            && matches_codes;
        if !matches {
            return load_failed(format!(
                "The vector ranges of \"{}\" do not match the field",
                file.file.path().display()
            ));
        }
        total += file.count;
    }
    Ok(total)
}

pub(crate) fn graph_of(
    layout: &GraphPartLayout,
    total: u32,
    parts: &[ColdGraphPart],
) -> Result<ColdGraph> {
    let max_layer = whole_number_within(layout.max_layer, f64::from(MAX_LAYER_CAP));
    let entry_point = match layout.entry_point {
        None => Some(None),
        Some(entry) => whole_number_within(entry, f64::from(u32::MAX))
            .filter(|&entry| entry < total)
            .map(Some),
    };
    let (Some(max_layer), Some(entry_point)) = (max_layer, entry_point) else {
        return load_failed("The disk vector graph does not cover the field");
    };
    if parts.len() != (total as usize).div_ceil(VECTOR_GRAPH_PART_VECTORS) {
        return load_failed("The disk vector graph does not cover the field");
    }
    for (at, part) in parts.iter().enumerate() {
        let count =
            (total as usize - at * VECTOR_GRAPH_PART_VECTORS).min(VECTOR_GRAPH_PART_VECTORS);
        let path = part.file.path().display();
        if part.levels.len() != count
            || part.node_offsets.len() != count + 1
            || part.node_offsets.first() != Some(&0)
        {
            return load_failed(format!(
                "The node ranges of \"{path}\" do not match the field"
            ));
        }
        let invalid = (0..count).find(|&node| {
            u32::from(part.levels[node]) > max_layer + 1
                || part.node_offsets[node] > part.node_offsets[node + 1]
                || u64::from(part.node_offsets[node + 1]) > part.neighbours.length
        });
        if let Some(node) = invalid {
            return load_failed(format!(
                "The node at position {node} of \"{path}\" has invalid layers or offsets"
            ));
        }
    }
    Ok(ColdGraph {
        entry_point,
        max_layer,
    })
}
