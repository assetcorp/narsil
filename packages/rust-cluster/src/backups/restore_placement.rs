use narsil::{Map, Value};

use super::manifest::read_allocation_constraints;
use super::types::RestoreConstraints;
use crate::constants::MAX_REPLICATION_FACTOR;

/// The replication factor and the placement rules that a restore request gives, each one absent where the request
/// leaves it out.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RestorePlacement {
    /// The replicas of each restored partition beside its primary.
    pub replication_factor: Option<u64>,
    /// The rules that place the restored partitions.
    pub constraints: Option<RestoreConstraints>,
}

fn is_absent(value: Option<&Value>) -> bool {
    matches!(value, None | Some(Value::Null))
}

/// Returns the replication factor and the placement rules of a restore request body, read the way a cluster node's
/// controller reads them.
///
/// # Errors
///
/// Returns the reason in words where `replicationFactor` is not an integer from 0 to 255, or where `constraints`
/// holds a `zoneAwareness` other than a boolean, a `zoneAttribute` other than a non-empty string, or a
/// `maxShardsPerNode` other than a positive integer.
pub fn read_restore_placement(request: &Map) -> Result<RestorePlacement, String> {
    let replication_factor = match request.get("replicationFactor") {
        found if is_absent(found) => None,
        Some(Value::Number(factor))
            if factor.fract() == 0.0 && (0.0..=MAX_REPLICATION_FACTOR).contains(factor) =>
        {
            Some(*factor as u64)
        }
        _ => {
            return Err(format!(
                "\"replicationFactor\" must be an integer from 0 to {MAX_REPLICATION_FACTOR}"
            ));
        }
    };
    let constraints = match request.get("constraints") {
        None | Some(Value::Null) => None,
        Some(raw) => {
            let Some(read) = read_allocation_constraints(raw) else {
                return Err("\"constraints\" must hold \"zoneAwareness\" as a boolean, \"zoneAttribute\" as a non-empty string, and \"maxShardsPerNode\" as a positive integer, or leave any of them out".to_string());
            };
            Some(RestoreConstraints {
                zone_awareness: read.zone_awareness,
                zone_attribute: read.zone_attribute,
                max_shards_per_node: read.max_shards_per_node.map(|shards| shards as u64),
            })
        }
    };
    Ok(RestorePlacement {
        replication_factor,
        constraints,
    })
}
