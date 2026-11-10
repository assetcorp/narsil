use crate::error::{ErrorCode, NarsilError, Result};
use crate::ffi;
use crate::format::graph_part::{Metric as GraphMetric, NumberedGraph};

use super::constants::{MAX_LAYER_CAP, UPPER_LIST_ALLOWANCE, UPPER_LISTS_PER_NODE_BOUND};
use super::graph::{GraphTables, upper_words_of};

pub(crate) const NO_ORDINAL: i32 = -1;
const NO_NUMBER: i32 = -1;
const NO_LAYER: i32 = -1;

pub(crate) fn graph_metric_of(code: u32) -> GraphMetric {
    match code {
        ffi::NARSIL_METRIC_DOT_PRODUCT => GraphMetric::DotProduct,
        ffi::NARSIL_METRIC_EUCLIDEAN => GraphMetric::Euclidean,
        _ => GraphMetric::Cosine,
    }
}

pub(crate) fn metric_code_of(metric: GraphMetric) -> u32 {
    match metric {
        GraphMetric::Cosine => ffi::NARSIL_METRIC_COSINE,
        GraphMetric::DotProduct => ffi::NARSIL_METRIC_DOT_PRODUCT,
        GraphMetric::Euclidean => ffi::NARSIL_METRIC_EUCLIDEAN,
    }
}

fn saved_top_layer(graph: &GraphTables, ordinal: i32) -> i32 {
    let Ok(ordinal) = u32::try_from(ordinal) else {
        return NO_LAYER;
    };
    if ordinal >= graph.slots() || !graph.holds_node(ordinal) {
        return NO_LAYER;
    }
    (i32::from(graph.level(ordinal)) - 1).min(i32::from(MAX_LAYER_CAP))
}

pub(crate) struct Numbering<'a> {
    pub(crate) number_of_ordinal: &'a [i32],
    pub(crate) ordinal_of_number: &'a [i32],
}

pub(crate) fn serialise_parts(
    graph: &GraphTables,
    numbering: &Numbering<'_>,
    part_size: usize,
) -> Vec<NumberedGraph> {
    let ordinal_of_number = numbering.ordinal_of_number;
    let number_of_ordinal = numbering.number_of_ordinal;
    let top_layers: Vec<i32> = ordinal_of_number
        .iter()
        .map(|&ordinal| saved_top_layer(graph, ordinal))
        .collect();
    let entry_number = graph
        .entry_point()
        .and_then(|ordinal| number_of_ordinal.get(ordinal as usize).copied())
        .filter(|&number| number != NO_NUMBER);
    let entry_point = entry_number
        .filter(|&number| top_layers.get(number as usize).is_some_and(|&top| top >= 0))
        .map(|number| number as u32);
    let max_layer = graph.top_layer().clamp(0, i32::from(MAX_LAYER_CAP)) as u8;
    let mut parts = Vec::new();
    let mut list = Vec::new();
    for start in (0..ordinal_of_number.len()).step_by(part_size.max(1)) {
        let end = (start + part_size).min(ordinal_of_number.len());
        let mut levels = Vec::with_capacity(end - start);
        let mut neighbours = Vec::new();
        for number in start..end {
            let top = top_layers[number];
            levels.push((top + 1) as u8);
            for layer in 0..=top {
                graph.list(ordinal_of_number[number] as u32, layer as u8, &mut list);
                let count_at = neighbours.len();
                neighbours.push(0u32);
                for &neighbour in &list {
                    let Some(&found) = number_of_ordinal.get(neighbour as usize) else {
                        continue;
                    };
                    if found == NO_NUMBER
                        || found as usize == number
                        || top_layers[found as usize] < layer
                    {
                        continue;
                    }
                    neighbours.push(found as u32);
                }
                neighbours[count_at] = (neighbours.len() - count_at - 1) as u32;
            }
        }
        parts.push(NumberedGraph {
            entry_point,
            max_layer,
            m: graph.m,
            ef_construction: graph.ef_construction.min(u32::from(u16::MAX)) as u16,
            metric: graph_metric_of(graph.metric),
            levels,
            neighbours,
            shuffled_build_count: None,
            calibrated_mean_length: None,
        });
    }
    parts
}

pub(crate) fn without_nodes(
    part: &NumberedGraph,
    first_number: usize,
    vanished: &[bool],
) -> NumberedGraph {
    let gone = |number: usize| vanished.get(number).copied().unwrap_or(false);
    let mut levels = part.levels.clone();
    let mut kept = Vec::with_capacity(part.neighbours.len());
    let mut cursor = 0usize;
    for (at, &level) in part.levels.iter().enumerate() {
        let start = cursor;
        for _ in 0..level {
            let count = part.neighbours.get(cursor).copied().unwrap_or(0) as usize;
            cursor = (cursor + count + 1).min(part.neighbours.len());
        }
        if gone(first_number + at) {
            levels[at] = 0;
            continue;
        }
        kept.extend_from_slice(&part.neighbours[start..cursor]);
    }
    let entry_point = part.entry_point.filter(|&number| !gone(number as usize));
    NumberedGraph {
        entry_point,
        levels,
        neighbours: kept,
        ..part.clone()
    }
}

fn ends_inside_a_list() -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_LOAD_FAILED,
        "Invalid vector graph payload: neighbours ends inside a list",
    )
}

pub(crate) fn require_whole_lists(part: &NumberedGraph) -> Result<()> {
    let mut cursor = 0usize;
    for &level in &part.levels {
        for _ in 0..level {
            let Some(&count) = part.neighbours.get(cursor) else {
                return Err(ends_inside_a_list());
            };
            if count as usize > part.neighbours.len() - cursor - 1 {
                return Err(ends_inside_a_list());
            }
            cursor += count as usize + 1;
        }
    }
    Ok(())
}

/// Refuses a graph whose parts hold more upper-layer lists than `4 * n / (m - 1) + 64`, where `n` counts its nodes,
/// before a restore commits memory to those lists.
pub(crate) fn require_upper_lists_within_bound(parts: &[NumberedGraph]) -> Result<()> {
    let Some(first) = parts.first() else {
        return Ok(());
    };
    let (mut nodes, mut upper_lists) = (0u128, 0u128);
    for level in parts.iter().flat_map(|part| part.levels.iter().copied()) {
        if level > 0 {
            nodes += 1;
            upper_lists += u128::from(level - 1);
        }
    }
    let divisor = u128::from(first.m.saturating_sub(1).max(1));
    let excess = upper_lists.saturating_sub(UPPER_LIST_ALLOWANCE);
    if excess * divisor <= UPPER_LISTS_PER_NODE_BOUND * nodes {
        return Ok(());
    }
    Err(NarsilError::new(
        ErrorCode::PERSISTENCE_LOAD_FAILED,
        format!(
            "Invalid vector graph payload: the graph holds {upper_lists} upper-layer lists, more than 4 * {nodes} / ({} - 1) + 64 allows",
            first.m
        ),
    ))
}

pub(crate) struct NumberedParts<'a> {
    pub(crate) parts: &'a [NumberedGraph],
    pub(crate) part_size: usize,
}

impl NumberedParts<'_> {
    pub(crate) fn top_layer(&self, number: usize) -> i32 {
        let size = self.part_size.max(1);
        let Some(part) = self.parts.get(number / size) else {
            return NO_LAYER;
        };
        part.levels
            .get(number % size)
            .map_or(NO_LAYER, |&level| i32::from(level) - 1)
    }

    fn numbers(&self) -> impl Iterator<Item = (usize, usize, &NumberedGraph, usize)> {
        let size = self.part_size.max(1);
        self.parts.iter().enumerate().flat_map(move |(p, part)| {
            (0..part.levels.len()).map(move |at| (p * size + at, p, part, at))
        })
    }
}

fn ordinal_at(ordinal_of_number: &[i32], number: usize) -> i32 {
    ordinal_of_number.get(number).copied().unwrap_or(NO_ORDINAL)
}

fn max_connections(graph: &GraphTables, layer: usize) -> usize {
    if layer == 0 {
        2 * graph.m as usize
    } else {
        graph.m as usize
    }
}

pub(crate) fn restore_numbered(
    numbered: &NumberedParts<'_>,
    ordinal_of_number: &[i32],
    slots: usize,
) -> Result<Option<GraphTables>> {
    let Some(first) = numbered.parts.first() else {
        return Ok(None);
    };
    for part in numbered.parts {
        require_whole_lists(part)?;
    }
    let m = first.m.max(1);
    let mut highest = 0usize;
    let mut upper = 0usize;
    for (number, _, part, at) in numbered.numbers() {
        let level = part.levels[at];
        let ordinal = ordinal_at(ordinal_of_number, number);
        if level == 0 || ordinal < 0 {
            continue;
        }
        highest = highest.max(ordinal as usize + 1);
        upper += upper_words_of(m, (level - 1).min(MAX_LAYER_CAP));
    }
    let graph = GraphTables::new(
        m,
        u32::from(first.ef_construction),
        metric_code_of(first.metric),
        highest.max(slots),
        upper,
    );
    let mut highest_layer = NO_LAYER;
    let mut node_on_highest_layer = None;
    let mut lists: Vec<Vec<u32>> = Vec::new();
    let mut cursors = vec![0usize; numbered.parts.len()];
    for (number, p, part, at) in numbered.numbers() {
        let top = i32::from(part.levels[at]) - 1;
        if top < 0 {
            continue;
        }
        let cursor = &mut cursors[p];
        let ordinal = ordinal_at(ordinal_of_number, number);
        let kept_top = top.min(i32::from(MAX_LAYER_CAP));
        lists.resize_with(kept_top as usize + 1, Vec::new);
        for layer in 0..=top as usize {
            let count = part.neighbours[*cursor] as usize;
            let values = &part.neighbours[*cursor + 1..*cursor + 1 + count];
            *cursor += count + 1;
            if layer > kept_top as usize {
                continue;
            }
            let limit = max_connections(&graph, layer);
            let Some(kept) = lists.get_mut(layer) else {
                continue;
            };
            kept.clear();
            for &neighbour in values {
                if kept.len() >= limit {
                    break;
                }
                let neighbour_ordinal = ordinal_at(ordinal_of_number, neighbour as usize);
                if neighbour_ordinal < 0
                    || neighbour as usize == number
                    || numbered.top_layer(neighbour as usize) < layer as i32
                {
                    continue;
                }
                if !kept.contains(&(neighbour_ordinal as u32)) {
                    kept.push(neighbour_ordinal as u32);
                }
            }
        }
        if ordinal >= 0
            && graph.restore_node(ordinal as u32, kept_top as u8, &lists[..=kept_top as usize])
            && kept_top > highest_layer
        {
            highest_layer = kept_top;
            node_on_highest_layer = Some(ordinal as u32);
        }
    }
    let entry = first.entry_point.and_then(|number| {
        let ordinal = ordinal_at(ordinal_of_number, number as usize);
        let top = numbered
            .top_layer(number as usize)
            .min(i32::from(MAX_LAYER_CAP));
        (ordinal >= 0 && top >= 0).then_some((ordinal as u32, top))
    });
    match entry {
        Some((ordinal, top)) => graph.set_entry(Some(ordinal), top),
        None => graph.set_entry(node_on_highest_layer, highest_layer),
    }
    graph.leave_incoming_uncounted();
    Ok(Some(graph))
}
