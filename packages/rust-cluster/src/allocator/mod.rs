mod assignment;
mod deciders;
mod departed_nodes;
mod initial;
mod leadership;
mod lost_nodes;
mod moves;
mod rebalance;
mod sizes;
mod surplus;
mod weight;

use std::collections::{HashMap, HashSet};

use narsil::Value;

pub(crate) use assignment::{ACTIVE, Assignment, Assignments, INITIALISING, Table, UNASSIGNED};
pub(crate) use departed_nodes::assignments_without_departed_nodes;
pub(crate) use lost_nodes::{LostNodes, handle_lost_nodes};

use self::deciders::Deciders;
use self::sizes::PartitionSizes;
use crate::coordinator::NodeRegistration;
use crate::error::{ClusterError, ClusterResult, codes};

pub(crate) const DATA_ROLE: &str = "data";

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Constraints {
    pub(crate) zone_awareness: bool,
    pub(crate) zone_attribute: String,
    pub(crate) max_shards_per_node: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Role {
    Primary,
    Replica,
}

pub(crate) struct NodeMap<'a> {
    ordered: Vec<&'a NodeRegistration>,
    by_id: HashMap<&'a str, &'a NodeRegistration>,
}

impl<'a> NodeMap<'a> {
    pub(crate) fn new(nodes: &[&'a NodeRegistration]) -> NodeMap<'a> {
        let mut ordered = Vec::with_capacity(nodes.len());
        let mut by_id = HashMap::with_capacity(nodes.len());
        for node in nodes {
            if by_id.insert(node.node_id.as_str(), *node).is_none() {
                ordered.push(*node);
            }
        }
        NodeMap { ordered, by_id }
    }

    pub(crate) fn get(&self, node_id: &str) -> Option<&'a NodeRegistration> {
        self.by_id.get(node_id).copied()
    }

    pub(crate) fn len(&self) -> usize {
        self.by_id.len()
    }

    pub(crate) fn all(&self) -> impl Iterator<Item = &'a NodeRegistration> + '_ {
        self.ordered.iter().copied()
    }
}

pub(crate) fn is_draining(node: &NodeRegistration) -> bool {
    matches!(node.extra.get("draining"), Some(Value::Bool(true)))
}

pub(crate) fn memory_is_full(node: &NodeRegistration) -> bool {
    matches!(
        node.extra
            .get("memory")
            .and_then(Value::as_object)
            .and_then(|memory| memory.get("full")),
        Some(Value::Bool(true))
    )
}

pub(crate) fn zone_of<'n>(node: &'n NodeRegistration, attribute: &str) -> Option<&'n Value> {
    node.extra
        .get("metadata")
        .and_then(Value::as_object)
        .and_then(|metadata| metadata.get(attribute))
}

pub(crate) fn holds_data_role(node: &NodeRegistration) -> bool {
    node.roles.iter().any(|role| role == DATA_ROLE)
}

pub(crate) fn sorted_by_node_id<'a>(nodes: &[&'a NodeRegistration]) -> Vec<&'a NodeRegistration> {
    let mut sorted = nodes.to_vec();
    sorted.sort_by(|left, right| crate::ordering::utf16_order(&left.node_id, &right.node_id));
    sorted
}

pub(crate) struct AllocationRequest<'a> {
    pub(crate) nodes: &'a [NodeRegistration],
    pub(crate) current: Option<&'a Table>,
    pub(crate) index_name: &'a str,
    pub(crate) partition_count: f64,
    pub(crate) replication_factor: f64,
    pub(crate) constraints: &'a Constraints,
    pub(crate) retained: &'a HashSet<String>,
}

pub(crate) fn allocate(request: &AllocationRequest<'_>) -> ClusterResult<Table> {
    if request.partition_count <= 0.0 {
        return Err(ClusterError::new(
            codes::ALLOCATION_INVALID_CONFIG,
            "partitionCount must be greater than 0",
        )
        .with_detail("partitionCount", Value::Number(request.partition_count)));
    }
    if request.replication_factor < 0.0 {
        return Err(ClusterError::new(
            codes::ALLOCATION_INVALID_CONFIG,
            "replicationFactor must be 0 or greater",
        )
        .with_detail(
            "replicationFactor",
            Value::Number(request.replication_factor),
        ));
    }
    let data_nodes: Vec<&NodeRegistration> = request
        .nodes
        .iter()
        .filter(|node| holds_data_role(node))
        .collect();
    if data_nodes.is_empty() {
        return Err(ClusterError::new(
            codes::ALLOCATION_NO_DATA_NODES,
            "No data nodes available for allocation",
        )
        .with_detail("totalNodes", Value::Number(request.nodes.len() as f64)));
    }
    let deciders = Deciders::new(
        request.constraints,
        PartitionSizes::read(request.nodes, request.index_name),
    );
    match request.current {
        None => initial::initial_allocate(
            &data_nodes,
            request.index_name,
            request.partition_count,
            request.replication_factor,
            &deciders,
        ),
        Some(current) => Ok(rebalance::rebalance_allocate(
            &data_nodes,
            current,
            request.replication_factor,
            &deciders,
            request.retained,
        )),
    }
}
