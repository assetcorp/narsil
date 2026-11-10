use super::{number, positive_integer};
use crate::value::{Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub(crate) struct PartitionLimits {
    pub(crate) max_docs_per_partition: Option<u64>,
    pub(crate) max_partitions: Option<u64>,
    pub(crate) watermark: Option<f64>,
}

pub(crate) fn limits_from_wire(value: Option<&Value>) -> Option<PartitionLimits> {
    let Value::Object(map) = value? else {
        return None;
    };
    let watermark =
        number(map.get("watermark")).filter(|fraction| *fraction > 0.0 && *fraction <= 1.0);
    let limits = PartitionLimits {
        max_docs_per_partition: positive_integer(map.get("max_docs_per_partition")),
        max_partitions: positive_integer(map.get("max_partitions")),
        watermark,
    };
    (limits != PartitionLimits::default()).then_some(limits)
}

pub(crate) fn limits_to_wire(limits: &PartitionLimits) -> Value {
    let mut map = Map::new();
    if let Some(value) = limits.max_docs_per_partition {
        map.insert("max_docs_per_partition", Value::Number(value as f64));
    }
    if let Some(value) = limits.max_partitions {
        map.insert("max_partitions", Value::Number(value as f64));
    }
    if let Some(value) = limits.watermark {
        map.insert("watermark", Value::Number(value));
    }
    Value::Object(map)
}
