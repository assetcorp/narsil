use std::collections::{HashMap, HashSet};

use crate::error::Result;
use crate::format::graph_part::{GraphParts, MAX_M, MIN_M, Metric, NumberedGraph};
use crate::value::{Map, Value};

use super::vector_parts::{EarlierVectorPart, invalid};

const MAX_LAYER_CAP: u8 = 32;
const LAYER_SLOTS: usize = MAX_LAYER_CAP as usize + 1;
const LAYER_ZERO_CONNECTION_FACTOR: usize = 2;
const UPPER_LISTS_PER_NODE_BOUND: u128 = 4;
const UPPER_LIST_ALLOWANCE: u128 = 64;
const MAX_EF_CONSTRUCTION: f64 = 65_535.0;

struct GraphSource<'a> {
    header: &'a Map,
    nodes: Vec<&'a Value>,
}

struct Header<'a> {
    m: u32,
    ef_construction: Option<u16>,
    metric: Option<Metric>,
    max_layer: u8,
    entry_point: Option<&'a str>,
}

struct ResolvedNode<'a> {
    number: u32,
    top: u8,
    layers: &'a [Value],
}

fn graph_sources<'a>(parts: &'a [(EarlierVectorPart, &'a [Value])]) -> Vec<GraphSource<'a>> {
    let mut sources: Vec<GraphSource<'a>> = Vec::new();
    let mut sequence_start = 0;
    for (index, (part, graphs)) in parts.iter().enumerate() {
        if index == 0 || part.part == 0 {
            sequence_start = sources.len();
        }
        for (g, graph) in graphs.iter().enumerate() {
            let Value::Object(header) = graph else {
                continue;
            };
            let Some(Value::Array(nodes)) = header.get("nodes") else {
                continue;
            };
            match sources.get_mut(sequence_start + g) {
                Some(source) => source.nodes.extend(nodes.iter()),
                None => sources.push(GraphSource {
                    header,
                    nodes: nodes.iter().collect(),
                }),
            }
        }
    }
    sources
}

fn header_of(map: &Map) -> Result<Header<'_>> {
    let m = match map.get("m") {
        Some(Value::Number(m))
            if m.fract() == 0.0 && (f64::from(MIN_M)..=f64::from(MAX_M)).contains(m) =>
        {
            *m as u32
        }
        _ => {
            return Err(invalid(format!(
                "m must be a whole number from {MIN_M} to {MAX_M}"
            )));
        }
    };
    let ef_construction = match map.get("efConstruction") {
        None | Some(Value::Null) => None,
        Some(Value::Number(ef))
            if ef.fract() == 0.0 && (0.0..=MAX_EF_CONSTRUCTION).contains(ef) =>
        {
            Some(*ef as u16)
        }
        Some(_) => return Err(invalid("efConstruction must be a uint16")),
    };
    let metric = map
        .get("metric")
        .and_then(Value::as_str)
        .and_then(Metric::parse);
    let max_layer = map
        .get("maxLayer")
        .and_then(Value::as_f64)
        .filter(|layer| !layer.is_nan())
        .map_or(0, |layer| layer.clamp(0.0, f64::from(MAX_LAYER_CAP)) as u8);
    let entry_point = map
        .get("entryPoint")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty());
    Ok(Header {
        m,
        ef_construction,
        metric,
        max_layer,
        entry_point,
    })
}

fn numbers_of<'a>(parts: &'a [(EarlierVectorPart, &'a [Value])]) -> Result<HashMap<&'a str, u32>> {
    let total: usize = parts.iter().map(|(part, _)| part.doc_ids.len()).sum();
    let mut numbers = HashMap::with_capacity(total);
    let ids = parts.iter().flat_map(|(part, _)| part.doc_ids.iter());
    for (number, id) in ids.enumerate() {
        let number = u32::try_from(number)
            .map_err(|_| invalid("a field holds more vectors than a uint32 counts"))?;
        numbers.insert(id.as_str(), number);
    }
    Ok(numbers)
}

fn malformed_node() -> crate::error::NarsilError {
    invalid("each graph node must list a document ID, a top layer, and its layers")
}

fn resolve<'a>(
    source: &GraphSource<'a>,
    numbers: &HashMap<&str, u32>,
) -> Result<Vec<ResolvedNode<'a>>> {
    let mut resolved: Vec<ResolvedNode<'a>> = Vec::new();
    let mut place: HashMap<u32, usize> = HashMap::new();
    for node in &source.nodes {
        let Value::Array(items) = node else {
            return Err(malformed_node());
        };
        let Some(&number) = items
            .first()
            .and_then(Value::as_str)
            .and_then(|id| numbers.get(id))
        else {
            continue;
        };
        let (Some(Value::Number(top)), Some(Value::Array(layers))) = (items.get(1), items.get(2))
        else {
            return Err(malformed_node());
        };
        if top.is_nan() {
            return Err(malformed_node());
        }
        let entry = ResolvedNode {
            number,
            top: top.clamp(0.0, f64::from(MAX_LAYER_CAP)) as u8,
            layers,
        };
        match place.get(&number).and_then(|&at| resolved.get_mut(at)) {
            Some(held) => *held = entry,
            None => {
                place.insert(number, resolved.len());
                resolved.push(entry);
            }
        }
    }
    Ok(resolved)
}

fn require_upper_lists_within_bound(nodes: &[ResolvedNode<'_>], m: u32) -> Result<()> {
    let count = nodes.len() as u128;
    let upper_lists: u128 = nodes.iter().map(|node| u128::from(node.top)).sum();
    let divisor = u128::from(m.saturating_sub(1).max(1));
    if upper_lists.saturating_sub(UPPER_LIST_ALLOWANCE) * divisor
        <= UPPER_LISTS_PER_NODE_BOUND * count
    {
        return Ok(());
    }
    Err(invalid(format!(
        "the graph holds {upper_lists} upper-layer lists, more than 4 * {count} / ({m} - 1) + 64 allows"
    )))
}

fn chosen_layers<'a>(node: &ResolvedNode<'a>) -> Result<[&'a [Value]; LAYER_SLOTS]> {
    let mut chosen: [&'a [Value]; LAYER_SLOTS] = [&[]; LAYER_SLOTS];
    for entry in node.layers {
        let Value::Array(items) = entry else {
            return Err(malformed_layer());
        };
        let (Some(Value::Number(layer)), Some(Value::Array(neighbours))) =
            (items.first(), items.get(1))
        else {
            return Err(malformed_layer());
        };
        if layer.fract() != 0.0 || *layer < 0.0 || *layer > f64::from(node.top) {
            continue;
        }
        if let Some(slot) = chosen.get_mut(*layer as usize) {
            *slot = neighbours;
        }
    }
    Ok(chosen)
}

fn malformed_layer() -> crate::error::NarsilError {
    invalid("each layer of a graph node must list a layer number and its neighbours")
}

fn write_lists(
    node: &ResolvedNode<'_>,
    m: u32,
    numbers: &HashMap<&str, u32>,
    out: &mut Vec<u32>,
) -> Result<()> {
    let chosen = chosen_layers(node)?;
    let mut kept: HashSet<u32> = HashSet::new();
    for (layer, listed) in chosen.iter().enumerate().take(usize::from(node.top) + 1) {
        let limit = if layer == 0 {
            LAYER_ZERO_CONNECTION_FACTOR * m as usize
        } else {
            m as usize
        };
        kept.clear();
        let count_at = out.len();
        out.push(0);
        for neighbour in listed.iter() {
            if kept.len() >= limit {
                break;
            }
            if let Some(&found) = neighbour.as_str().and_then(|id| numbers.get(id))
                && kept.insert(found)
            {
                out.push(found);
            }
        }
        if let Some(count) = out.get_mut(count_at) {
            *count = kept.len() as u32;
        }
    }
    Ok(())
}

fn levels_length(nodes: &[ResolvedNode<'_>]) -> usize {
    nodes
        .iter()
        .map(|node| node.number as usize + 1)
        .max()
        .unwrap_or(0)
}

fn numbered_graph(header: &Header<'_>, metric: Metric, ef_construction: u16) -> NumberedGraph {
    NumberedGraph {
        entry_point: None,
        max_layer: 0,
        m: header.m,
        ef_construction,
        metric,
        levels: Vec::new(),
        neighbours: Vec::new(),
        shuffled_build_count: None,
        calibrated_mean_length: None,
    }
}

fn first_graph(
    header: &Header<'_>,
    mut nodes: Vec<ResolvedNode<'_>>,
    numbers: &HashMap<&str, u32>,
    template: NumberedGraph,
) -> Result<NumberedGraph> {
    nodes.sort_by_key(|node| node.number);
    let mut levels = vec![0u8; levels_length(&nodes)];
    let mut neighbours = Vec::new();
    for node in &nodes {
        if let Some(level) = levels.get_mut(node.number as usize) {
            *level = node.top + 1;
        }
        write_lists(node, header.m, numbers, &mut neighbours)?;
    }
    let entry_point = header
        .entry_point
        .and_then(|id| numbers.get(id).copied())
        .filter(|&number| levels.get(number as usize).is_some_and(|&level| level > 0));
    Ok(NumberedGraph {
        entry_point,
        max_layer: header.max_layer,
        levels,
        neighbours,
        ..template
    })
}

fn later_graph(later: &[Vec<ResolvedNode<'_>>], template: NumberedGraph) -> Option<NumberedGraph> {
    let length = later
        .iter()
        .map(|nodes| levels_length(nodes))
        .max()
        .unwrap_or(0);
    if length == 0 {
        return None;
    }
    let mut levels = vec![0u8; length];
    for node in later.iter().flatten() {
        if let Some(level) = levels.get_mut(node.number as usize) {
            *level = 1;
        }
    }
    let held = levels.iter().filter(|&&level| level > 0).count();
    Some(NumberedGraph {
        levels,
        neighbours: vec![0; held],
        ..template
    })
}

/// Numbers the HNSW graphs of one field's parts by the position of each vector across the parts, as a restore of
/// the reference implementation resolves each node's document ID, and checks each graph that has a node.
pub(super) fn earlier_graph_parts(
    parts: &[(EarlierVectorPart, &[Value])],
) -> Result<Option<GraphParts>> {
    let sources: Vec<GraphSource<'_>> = graph_sources(parts)
        .into_iter()
        .filter(|source| !source.nodes.is_empty())
        .collect();
    let headers = sources
        .iter()
        .map(|source| header_of(source.header))
        .collect::<Result<Vec<_>>>()?;
    let numbers = numbers_of(parts)?;
    let mut resolved = Vec::with_capacity(sources.len());
    for (source, header) in sources.iter().zip(&headers) {
        let nodes = resolve(source, &numbers)?;
        require_upper_lists_within_bound(&nodes, header.m)?;
        resolved.push(nodes);
    }
    let mut graphs = resolved.into_iter();
    let (Some(header), Some(first_nodes)) = (headers.first(), graphs.next()) else {
        return Ok(None);
    };
    let (Some(metric), Some(ef_construction)) = (header.metric, header.ef_construction) else {
        return Ok(None);
    };
    let template = numbered_graph(header, metric, ef_construction);
    let later: Vec<Vec<ResolvedNode<'_>>> = graphs.collect();
    let first = first_graph(header, first_nodes, &numbers, template.clone())?;
    let mut numbered = vec![first];
    numbered.extend(later_graph(&later, template));
    let field_name = parts
        .first()
        .map(|(part, _)| part.field_name.clone())
        .unwrap_or_default();
    Ok(Some(GraphParts {
        field_name,
        part_size: numbered
            .iter()
            .map(|graph| graph.levels.len().max(1))
            .collect(),
        graphs: numbered.into_iter().map(|graph| vec![graph]).collect(),
    }))
}
