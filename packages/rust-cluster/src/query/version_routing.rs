use std::collections::{BTreeSet, HashMap, HashSet};

use narsil::Value;

use crate::allocator::{Assignment, Table};
use crate::constants::{BM25_TUNING_SPEC_VERSION, PHRASE_SEARCH_SPEC_VERSION};
use crate::coordinator::NodeRegistration;
use crate::error::{ClusterError, codes};
use crate::version::reaches_version;

const QUOTE_CHARACTERS: [char; 4] = ['"', '\u{201c}', '\u{201d}', '\u{201e}'];

pub(crate) fn query_reads_phrases(term: Option<&str>) -> bool {
    let Some(term) = term else {
        return false;
    };
    if !term.contains(QUOTE_CHARACTERS) {
        return false;
    }
    term.split(QUOTE_CHARACTERS)
        .skip(1)
        .step_by(2)
        .any(|quoted| !quoted.trim().is_empty())
}

pub(crate) fn copy_holders_of(table: &Table) -> BTreeSet<String> {
    let mut holders = BTreeSet::new();
    for assignment in table.assignments.values() {
        if let Some(primary) = &assignment.primary {
            holders.insert(primary.clone());
        }
        holders.extend(assignment.replicas.iter().cloned());
        if let Some(removing) = &assignment.removing_replicas {
            holders.extend(removing.iter().cloned());
        }
    }
    holders
}

fn with_registered_copies(assignment: &Assignment, registered: &HashSet<&str>) -> Assignment {
    let mut routed = assignment.clone();
    routed.primary = assignment
        .primary
        .clone()
        .filter(|primary| registered.contains(primary.as_str()));
    routed.replicas = assignment
        .replicas
        .iter()
        .filter(|replica| registered.contains(replica.as_str()))
        .cloned()
        .collect();
    routed
}

fn older_holders(table: &Table, nodes: &[NodeRegistration], minimum: &str) -> Vec<String> {
    let versions: HashMap<&str, &str> = nodes
        .iter()
        .map(|node| (node.node_id.as_str(), node.version.as_str()))
        .collect();
    copy_holders_of(table)
        .into_iter()
        .filter(|holder| {
            versions
                .get(holder.as_str())
                .is_some_and(|version| !reaches_version(version, minimum))
        })
        .collect()
}

fn registered_routing(table: &Table, nodes: &[NodeRegistration]) -> Table {
    let registered: HashSet<&str> = nodes.iter().map(|node| node.node_id.as_str()).collect();
    let mut routed = table.clone();
    for assignment in routed.assignments.values_mut() {
        *assignment = with_registered_copies(assignment, &registered);
    }
    routed
}

fn below_version(
    code: &str,
    message: String,
    older: Vec<String>,
    minimum: &str,
    index_name: &str,
) -> ClusterError {
    ClusterError::new(code, message)
        .with_detail("indexName", Value::from(index_name))
        .with_detail(
            "nodeIds",
            Value::Array(older.into_iter().map(Value::from).collect()),
        )
        .with_detail("minimumVersion", Value::from(minimum))
}

pub(crate) fn bm25_not_ready(subject: &str, older: Vec<String>, index_name: &str) -> ClusterError {
    let message = format!(
        "{subject} {} node(s) below specification version {BM25_TUNING_SPEC_VERSION}, which cannot use BM25 parameters that the index or the search sets. Try again once every node registers that version",
        older.len()
    );
    below_version(
        codes::BM25_NOT_READY,
        message,
        older,
        BM25_TUNING_SPEC_VERSION,
        index_name,
    )
}

pub(crate) fn allocation_for_bm25_query(
    index_name: &str,
    table: &Table,
    nodes: &[NodeRegistration],
) -> Result<Table, ClusterError> {
    let older = older_holders(table, nodes, BM25_TUNING_SPEC_VERSION);
    if !older.is_empty() {
        return Err(bm25_not_ready(
            &format!("Index '{index_name}' has copies on"),
            older,
            index_name,
        ));
    }
    Ok(registered_routing(table, nodes))
}

pub(crate) fn allocation_for_phrase_query(
    index_name: &str,
    table: &Table,
    nodes: &[NodeRegistration],
) -> Result<Table, ClusterError> {
    let older = older_holders(table, nodes, PHRASE_SEARCH_SPEC_VERSION);
    if !older.is_empty() {
        let message = format!(
            "Index '{index_name}' has copies on {} node(s) below specification version {PHRASE_SEARCH_SPEC_VERSION}, which cannot match a phrase. Try the query again once every node registers that version",
            older.len()
        );
        return Err(below_version(
            codes::SEARCH_PHRASE_NOT_READY,
            message,
            older,
            PHRASE_SEARCH_SPEC_VERSION,
            index_name,
        ));
    }
    Ok(registered_routing(table, nodes))
}
