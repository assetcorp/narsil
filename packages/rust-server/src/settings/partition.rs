use narsil::{Map, Narsil, PartitionConfig, Value};

use super::constants::MAX_PARTITIONS;
use super::errors::{after_engine_checks, config_invalid};
use super::js_text::is_whole_number;
use crate::errors::{Outcome, ServerError};

struct Refusal {
    failure: ServerError,
    sentinel: PartitionConfig,
}

fn refusal(field: &str, value: &Value, message: String, sentinel: PartitionConfig) -> Box<Refusal> {
    Box::new(Refusal {
        failure: config_invalid(message).with_detail(field, value.clone()),
        sentinel,
    })
}

fn whole_number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) if is_whole_number(*number) => Some(*number),
        _ => None,
    }
}

fn checked_change(fields: Option<&Map>) -> Result<PartitionConfig, Box<Refusal>> {
    let field = |name: &str| fields.and_then(|fields| fields.get(name));
    let mut change = PartitionConfig::default();
    if let Some(value) = field("maxDocsPerPartition") {
        match whole_number(value) {
            Some(count) if count >= 1.0 => change.max_docs_per_partition = Some(count as u64),
            _ => {
                return Err(refusal(
                    "maxDocsPerPartition",
                    value,
                    "partitions.maxDocsPerPartition must be a positive integer".to_string(),
                    PartitionConfig {
                        max_docs_per_partition: Some(0),
                        ..PartitionConfig::default()
                    },
                ));
            }
        }
    }
    if let Some(value) = field("maxPartitions") {
        match whole_number(value) {
            Some(count) if (1.0..=MAX_PARTITIONS).contains(&count) => {
                change.max_partitions = Some(count as u64)
            }
            _ => {
                return Err(refusal(
                    "maxPartitions",
                    value,
                    format!(
                        "partitions.maxPartitions must be an integer from 1 to {MAX_PARTITIONS}"
                    ),
                    PartitionConfig {
                        max_partitions: Some(0),
                        ..PartitionConfig::default()
                    },
                ));
            }
        }
    }
    if let Some(value) = field("watermark") {
        match value {
            Value::Number(watermark) if *watermark > 0.0 && *watermark <= 1.0 => {
                change.watermark = Some(*watermark)
            }
            _ => {
                return Err(refusal(
                    "watermark",
                    value,
                    "partitions.watermark must be above 0 and at most 1".to_string(),
                    PartitionConfig {
                        watermark: Some(f64::NAN),
                        ..PartitionConfig::default()
                    },
                ));
            }
        }
    }
    Ok(change)
}

pub(crate) fn update_partition_config(
    engine: &Narsil,
    index_name: &str,
    body: &Value,
) -> Outcome<()> {
    let fields = match body {
        Value::Object(fields) => Some(fields),
        _ => None,
    };
    match checked_change(fields) {
        Ok(change) => engine
            .update_partition_config(index_name, &change)
            .map_err(ServerError::from),
        Err(refused) => {
            let Refusal { failure, sentinel } = *refused;
            Err(after_engine_checks(
                engine,
                failure,
                |engine| engine.update_partition_config(index_name, &sentinel),
                |raised| raised.code().as_str() == "CONFIG_INVALID",
            ))
        }
    }
}
