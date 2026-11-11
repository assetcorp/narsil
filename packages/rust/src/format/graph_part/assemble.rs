use super::{GraphPart, GraphParts, NumberedGraph, PART_PREFIX, VECTOR_GRAPH_PART_VECTORS};
use crate::error::{ErrorCode, NarsilError, Result};

fn part_error(message: String) -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_LOAD_FAILED,
        format!("{PART_PREFIX}{message}"),
    )
}

fn same_header(left: &NumberedGraph, right: &NumberedGraph) -> bool {
    left.entry_point == right.entry_point
        && left.max_layer == right.max_layer
        && left.m == right.m
        && left.ef_construction == right.ef_construction
        && left.metric == right.metric
        && left.shuffled_build_count == right.shuffled_build_count
        && left.calibrated_mean_length == right.calibrated_mean_length
}

fn require_one_graph_per_vector(part: &GraphPart, p: usize) -> Result<()> {
    if part.graphs.len() < 2 {
        return Ok(());
    }
    let mut held = vec![false; VECTOR_GRAPH_PART_VECTORS];
    for graph in &part.graphs {
        for (at, &level) in graph.levels.iter().enumerate() {
            if level == 0 {
                continue;
            }
            if held[at] {
                let vector = p * VECTOR_GRAPH_PART_VECTORS + at;
                return Err(part_error(format!(
                    "part {p} gives vector {vector} a node in two graphs"
                )));
            }
            held[at] = true;
        }
    }
    Ok(())
}

/// Joins the parts of one field's graphs, checking that every part repeats the headers of part 0.
pub(crate) fn assemble_graph_parts(parts: Vec<GraphPart>) -> Result<GraphParts> {
    let Some(first) = parts.first().cloned() else {
        return Err(part_error(
            "a field that holds a graph must have at least one part".to_string(),
        ));
    };
    let mut lists: Vec<Vec<NumberedGraph>> = first.graphs.iter().map(|_| Vec::new()).collect();
    let last = parts.len() - 1;
    for (p, part) in parts.into_iter().enumerate() {
        if part.field_name != first.field_name || part.graphs.len() != first.graphs.len() {
            return Err(part_error(format!(
                "part {p} lists other graphs than part 0"
            )));
        }
        for (g, graph) in part.graphs.iter().enumerate() {
            if !same_header(graph, &first.graphs[g]) {
                return Err(part_error(format!(
                    "part {p} gives graph {g} other headers"
                )));
            }
            let levels = graph.levels.len();
            let fits = if p == last {
                (1..=VECTOR_GRAPH_PART_VECTORS).contains(&levels)
            } else {
                levels == VECTOR_GRAPH_PART_VECTORS
            };
            if !fits {
                return Err(part_error(format!(
                    "part {p} gives graph {g} {levels} bytes of levels"
                )));
            }
        }
        require_one_graph_per_vector(&part, p)?;
        for (g, graph) in part.graphs.into_iter().enumerate() {
            lists[g].push(graph);
        }
    }
    Ok(GraphParts {
        field_name: first.field_name,
        part_size: vec![VECTOR_GRAPH_PART_VECTORS; lists.len()],
        graphs: lists,
    })
}
