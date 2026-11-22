use std::collections::HashMap;

use narsil::{Map, Value};

use crate::coordinator::AllocationTable;

pub(crate) const UNASSIGNED: &str = "UNASSIGNED";
pub(crate) const INITIALISING: &str = "INITIALISING";
pub(crate) const ACTIVE: &str = "ACTIVE";

const ASSIGNMENT_FIELDS: [&str; 10] = [
    "primary",
    "replicas",
    "inSyncSet",
    "inSyncVersion",
    "commitPoint",
    "state",
    "primaryTerm",
    "removingReplicas",
    "lastHolders",
    "unassignedReason",
];

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Assignment {
    pub(crate) primary: Option<String>,
    pub(crate) replicas: Vec<String>,
    pub(crate) in_sync_set: Vec<String>,
    pub(crate) in_sync_version: Option<f64>,
    pub(crate) removing_replicas: Option<Vec<String>>,
    pub(crate) last_holders: Option<Vec<String>>,
    pub(crate) state: String,
    pub(crate) primary_term: f64,
    pub(crate) commit_point: f64,
    pub(crate) unassigned_reason: Option<String>,
    pub(crate) extra: Map,
}

fn strings_in(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(entries)) => entries
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

fn optional_strings(value: Option<&Value>) -> Option<Vec<String>> {
    matches!(value, Some(Value::Array(_))).then(|| strings_in(value))
}

fn number_in(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(number)) => Some(*number),
        _ => None,
    }
}

fn string_values(entries: &[String]) -> Value {
    Value::Array(entries.iter().cloned().map(Value::String).collect())
}

impl Assignment {
    pub(crate) fn from_map(fields: &Map) -> Assignment {
        let mut extra = Map::new();
        for (name, value) in fields.iter() {
            if !ASSIGNMENT_FIELDS.contains(&name.as_str()) {
                extra.insert(name.clone(), value.clone());
            }
        }
        Assignment {
            primary: fields
                .get("primary")
                .and_then(Value::as_str)
                .map(str::to_string),
            replicas: strings_in(fields.get("replicas")),
            in_sync_set: strings_in(fields.get("inSyncSet")),
            in_sync_version: number_in(fields.get("inSyncVersion")),
            removing_replicas: optional_strings(fields.get("removingReplicas")),
            last_holders: optional_strings(fields.get("lastHolders")),
            state: fields
                .get("state")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            primary_term: number_in(fields.get("primaryTerm")).unwrap_or(0.0),
            commit_point: number_in(fields.get("commitPoint")).unwrap_or(0.0),
            unassigned_reason: fields
                .get("unassignedReason")
                .and_then(Value::as_str)
                .map(str::to_string),
            extra,
        }
    }

    pub(crate) fn to_map(&self) -> Map {
        let mut fields = Map::with_capacity(ASSIGNMENT_FIELDS.len() + self.extra.len());
        fields.insert(
            "primary",
            self.primary.clone().map_or(Value::Null, Value::String),
        );
        fields.insert("replicas", string_values(&self.replicas));
        fields.insert("inSyncSet", string_values(&self.in_sync_set));
        if let Some(version) = self.in_sync_version {
            fields.insert("inSyncVersion", Value::Number(version));
        }
        fields.insert("commitPoint", Value::Number(self.commit_point));
        fields.insert("state", Value::String(self.state.clone()));
        fields.insert("primaryTerm", Value::Number(self.primary_term));
        if let Some(removing) = &self.removing_replicas {
            fields.insert("removingReplicas", string_values(removing));
        }
        if let Some(holders) = &self.last_holders {
            fields.insert("lastHolders", string_values(holders));
        }
        if let Some(reason) = &self.unassigned_reason {
            fields.insert("unassignedReason", Value::String(reason.clone()));
        }
        for (name, value) in self.extra.iter() {
            fields.insert(name.clone(), value.clone());
        }
        fields
    }

    pub(crate) fn in_sync_version_of(&self) -> f64 {
        self.in_sync_version.unwrap_or(0.0)
    }

    pub(crate) fn last_holders_of(&self) -> &[String] {
        self.last_holders.as_deref().unwrap_or_default()
    }

    pub(crate) fn is_removing(&self, node_id: &str) -> bool {
        self.removing_replicas
            .as_ref()
            .is_some_and(|removing| removing.iter().any(|id| id == node_id))
    }

    pub(crate) fn replicas_outside_move(&self) -> Vec<String> {
        self.replicas
            .iter()
            .filter(|id| !self.is_removing(id))
            .cloned()
            .collect()
    }

    pub(crate) fn holds_replica(&self, node_id: &str) -> bool {
        self.replicas.iter().any(|id| id == node_id)
    }

    pub(crate) fn holds_in_sync(&self, node_id: &str) -> bool {
        self.in_sync_set.iter().any(|id| id == node_id)
    }

    pub(crate) fn is_primary(&self, node_id: &str) -> bool {
        self.primary.as_deref() == Some(node_id)
    }

    pub(crate) fn without_unknown_fields(&self) -> Assignment {
        Assignment {
            extra: Map::new(),
            ..self.clone()
        }
    }
}

fn position_key(partition_id: f64) -> u64 {
    if partition_id == 0.0 {
        0.0f64.to_bits()
    } else if partition_id.is_nan() {
        f64::NAN.to_bits()
    } else {
        partition_id.to_bits()
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Assignments {
    entries: Vec<(f64, Assignment)>,
    positions: HashMap<u64, usize>,
}

impl Assignments {
    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub(crate) fn get(&self, partition_id: f64) -> Option<&Assignment> {
        let position = *self.positions.get(&position_key(partition_id))?;
        self.entries.get(position).map(|(_, assignment)| assignment)
    }

    pub(crate) fn get_mut(&mut self, partition_id: f64) -> Option<&mut Assignment> {
        let position = *self.positions.get(&position_key(partition_id))?;
        self.entries
            .get_mut(position)
            .map(|(_, assignment)| assignment)
    }

    pub(crate) fn set(&mut self, partition_id: f64, assignment: Assignment) {
        let key = position_key(partition_id);
        if let Some(position) = self.positions.get(&key).copied()
            && let Some(slot) = self.entries.get_mut(position)
        {
            slot.1 = assignment;
            return;
        }
        self.positions.insert(key, self.entries.len());
        self.entries.push((partition_id, assignment));
    }

    pub(crate) fn iter(&self) -> impl Iterator<Item = (f64, &Assignment)> {
        self.entries
            .iter()
            .map(|(partition_id, assignment)| (*partition_id, assignment))
    }

    pub(crate) fn values(&self) -> impl Iterator<Item = &Assignment> {
        self.entries.iter().map(|(_, assignment)| assignment)
    }

    pub(crate) fn values_mut(&mut self) -> impl Iterator<Item = &mut Assignment> {
        self.entries.iter_mut().map(|(_, assignment)| assignment)
    }

    pub(crate) fn ids(&self) -> Vec<f64> {
        self.entries
            .iter()
            .map(|(partition_id, _)| *partition_id)
            .collect()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Table {
    pub(crate) index_name: String,
    pub(crate) version: f64,
    pub(crate) replication_factor: f64,
    pub(crate) assignments: Assignments,
    pub(crate) generation: Option<String>,
    pub(crate) index_uuid: Option<String>,
}

impl Table {
    pub(crate) fn from_stored(table: &AllocationTable) -> Table {
        let mut assignments = Assignments::default();
        for (partition_id, fields) in &table.assignments {
            assignments.set(*partition_id, Assignment::from_map(fields));
        }
        Table {
            index_name: table.index_name.clone(),
            version: table.version,
            replication_factor: table.replication_factor,
            assignments,
            generation: table.generation.clone(),
            index_uuid: table.index_uuid.clone(),
        }
    }

    pub(crate) fn to_stored(&self) -> AllocationTable {
        AllocationTable {
            index_name: self.index_name.clone(),
            version: self.version,
            replication_factor: self.replication_factor,
            assignments: self
                .assignments
                .iter()
                .map(|(partition_id, assignment)| (partition_id, assignment.to_map()))
                .collect(),
            generation: self.generation.clone(),
            index_uuid: self.index_uuid.clone(),
        }
    }
}
