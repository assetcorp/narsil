use crate::error::Result;
use crate::format::graph_part::{GraphPart, NumberedGraph, VECTOR_GRAPH_PART_VECTORS};

use super::super::build::connect_unreached;
use super::super::field::{Shared, Writer};
use super::super::graph::GraphTables;
use super::super::numbered::{NO_ORDINAL, Numbering, serialise_parts};
use super::{SavedVectorFile, is_carried};

fn copied_with_every_placement_connected(
    writer: &Writer,
    graph: &GraphTables,
    numbering: &Numbering<'_>,
) -> Result<Vec<NumberedGraph>> {
    let _no_placement = graph.placements.hold_placements_back();
    if graph.placements.placed_since_connect() {
        connect_unreached(writer, graph)?;
    }
    Ok(serialise_parts(graph, numbering, VECTOR_GRAPH_PART_VECTORS))
}

pub(super) fn graph_parts_of(
    shared: &Shared,
    writer: &Writer,
    kept: &[SavedVectorFile],
    written: &[u32],
) -> Result<Option<Vec<GraphPart>>> {
    let generation = &writer.generation;
    let Some(graph) = generation.graph.as_ref() else {
        return Ok(None);
    };
    let total = kept.iter().map(|file| file.ordinals.len()).sum::<usize>() + written.len();
    if total == 0 {
        return Ok(None);
    }
    let mut number_of_ordinal = vec![NO_ORDINAL; generation.store.slots() as usize];
    let mut ordinal_of_number = vec![NO_ORDINAL; total];
    let mut number = 0usize;
    for file in kept {
        for &ordinal in &file.ordinals {
            if is_carried(generation, ordinal)
                && let Some(slot) = number_of_ordinal.get_mut(ordinal as usize)
            {
                *slot = number as i32;
                ordinal_of_number[number] = ordinal;
            }
            number += 1;
        }
    }
    for &ordinal in written {
        number_of_ordinal[ordinal as usize] = number as i32;
        ordinal_of_number[number] = ordinal as i32;
        number += 1;
    }
    let numbering = Numbering {
        number_of_ordinal: &number_of_ordinal,
        ordinal_of_number: &ordinal_of_number,
    };
    let shuffled = shared.history.shuffled_build_count();
    let parts = copied_with_every_placement_connected(writer, graph, &numbering)?;
    Ok(Some(
        parts
            .into_iter()
            .map(|mut part| {
                if let Some(count) = shuffled {
                    part.shuffled_build_count = Some(count.min(u64::from(u32::MAX)) as u32);
                    part.calibrated_mean_length = writer.calibrated_mean_length;
                }
                GraphPart {
                    field_name: shared.settings.field_name.clone(),
                    graphs: vec![part],
                }
            })
            .collect(),
    ))
}
