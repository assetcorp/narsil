use std::collections::BTreeMap;

use narsil::{Map, Value};

use super::results::{invalid, whole_number};
use crate::constants::{
    MAX_DOC_ID_LENGTH, MAX_FACET_BUCKETS, MAX_FACET_FIELDS, MAX_FACET_VALUE_LENGTH,
    MAX_GROUPS_PER_RESPONSE, MAX_PARTITION_COUNT, MAX_RESULTS_PER_PARTITION,
    MAX_SEARCH_CONTEXT_ID_LENGTH, MAX_SORT_FIELDS,
};
use crate::error::ClusterResult;

const SEARCH_RESULT: &str = "Invalid SearchResultPayload";

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ScoredEntry {
    pub(crate) doc_id: String,
    pub(crate) score: Option<f64>,
    pub(crate) sort_values: Option<Vec<Value>>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PartitionSearchResult {
    pub(crate) partition_id: u32,
    pub(crate) total_hits: u64,
    pub(crate) scored: Vec<ScoredEntry>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct WireGroupEntry {
    pub(crate) values: Map,
    pub(crate) scored: Vec<ScoredEntry>,
}

pub(crate) type FacetBuckets = Vec<(String, Vec<(String, u64)>)>;

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct SearchAnswer {
    pub(crate) results: Vec<PartitionSearchResult>,
    pub(crate) facets: Option<FacetBuckets>,
    pub(crate) facet_error_bounds: Option<BTreeMap<String, u64>>,
    pub(crate) groups: Option<Vec<WireGroupEntry>>,
    pub(crate) context_id: Option<String>,
}

fn utf16_length(text: &str) -> usize {
    text.encode_utf16().count()
}

fn absent(value: Option<&Value>) -> bool {
    matches!(value, None | Some(Value::Null))
}

fn count_of(value: Option<&Value>) -> Option<u64> {
    whole_number(value)
        .filter(|number| *number >= 0.0)
        .map(|number| number as u64)
}

fn sort_values_of(value: Option<&Value>, label: &str) -> ClusterResult<Option<Vec<Value>>> {
    let values = match value {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Array(values)) => values,
        Some(_) => {
            return Err(invalid(format!(
                "{SEARCH_RESULT}: \"{label}.sortValues\" must be an array or null"
            )));
        }
    };
    if values.len() > MAX_SORT_FIELDS {
        return Err(invalid(format!(
            "{SEARCH_RESULT}: \"{label}.sortValues\" carries more than {MAX_SORT_FIELDS} values"
        ))
        .with_detail("length", Value::from(values.len()))
        .with_detail("limit", Value::from(MAX_SORT_FIELDS)));
    }
    for sort_value in values {
        let accepted = match sort_value {
            Value::Null | Value::String(_) | Value::Bool(_) => true,
            Value::Number(number) => number.is_finite(),
            _ => false,
        };
        if !accepted {
            return Err(invalid(format!(
                "{SEARCH_RESULT}: \"{label}.sortValues\" accepts a string, a finite number, a boolean, or null"
            )));
        }
    }
    Ok(Some(values.clone()))
}

fn scored_entry(value: &Value, label: &str) -> ClusterResult<ScoredEntry> {
    let Value::Object(entry) = value else {
        return Err(invalid(format!(
            "{SEARCH_RESULT}: \"{label}\" must be an object"
        )));
    };
    let Some(Value::String(doc_id)) = entry.get("docId") else {
        return Err(invalid(format!(
            "{SEARCH_RESULT}: \"{label}.docId\" must be a string"
        )));
    };
    let length = utf16_length(doc_id);
    if length == 0 || length > MAX_DOC_ID_LENGTH {
        return Err(invalid(format!(
            "{SEARCH_RESULT}: \"{label}.docId\" length must be between 1 and {MAX_DOC_ID_LENGTH}"
        ))
        .with_detail("length", Value::from(length))
        .with_detail("limit", Value::from(MAX_DOC_ID_LENGTH)));
    }
    let score = match entry.get("score") {
        None | Some(Value::Null) => {
            if !matches!(entry.get("sortValues"), Some(Value::Array(_))) {
                return Err(invalid(format!(
                    "{SEARCH_RESULT}: \"{label}.score\" is absent only where \"sortValues\" carries the sort key"
                )));
            }
            None
        }
        Some(Value::Number(score)) => Some(*score),
        Some(_) => {
            return Err(invalid(format!(
                "{SEARCH_RESULT}: \"{label}.score\" must be a number"
            )));
        }
    };
    Ok(ScoredEntry {
        doc_id: doc_id.clone(),
        score,
        sort_values: sort_values_of(entry.get("sortValues"), label)?,
    })
}

fn scored_list(value: Option<&Value>, label: &str) -> ClusterResult<Vec<ScoredEntry>> {
    let Some(Value::Array(entries)) = value else {
        return Err(invalid(format!(
            "{SEARCH_RESULT}: \"{label}\" must be an array"
        )));
    };
    if entries.len() > MAX_RESULTS_PER_PARTITION {
        return Err(invalid(format!(
            "{SEARCH_RESULT}: \"{label}\" exceeds maximum length of {MAX_RESULTS_PER_PARTITION}"
        ))
        .with_detail("length", Value::from(entries.len()))
        .with_detail("limit", Value::from(MAX_RESULTS_PER_PARTITION)));
    }
    entries
        .iter()
        .enumerate()
        .map(|(at, entry)| scored_entry(entry, &format!("{label}[{at}]")))
        .collect()
}

fn partition_result(value: &Value, label: &str) -> ClusterResult<PartitionSearchResult> {
    let Value::Object(result) = value else {
        return Err(invalid(format!(
            "{SEARCH_RESULT}: \"{label}\" must be an object"
        )));
    };
    let Some(partition_id) = whole_number(result.get("partitionId")) else {
        return Err(invalid(format!(
            "Invalid payload: \"{label}.partitionId\" must be a finite integer"
        )));
    };
    if !(0.0..MAX_PARTITION_COUNT).contains(&partition_id) {
        return Err(invalid(format!(
            "Invalid payload: \"{label}.partitionId\" must be between 0 and {}",
            MAX_PARTITION_COUNT - 1.0
        ))
        .with_detail("value", Value::from(partition_id))
        .with_detail("limit", Value::from(MAX_PARTITION_COUNT)));
    }
    let Some(total_hits) = count_of(result.get("totalHits")) else {
        return Err(invalid(format!(
            "{SEARCH_RESULT}: \"{label}.totalHits\" must be a non-negative integer"
        )));
    };
    Ok(PartitionSearchResult {
        partition_id: partition_id as u32,
        total_hits,
        scored: scored_list(result.get("scored"), &format!("{label}.scored"))?,
    })
}

fn facet_bucket(value: &Value, label: &str) -> ClusterResult<(String, u64)> {
    let Value::Object(bucket) = value else {
        return Err(invalid(format!(
            "{SEARCH_RESULT}: \"{label}\" must be an object"
        )));
    };
    let Some(Value::String(text)) = bucket.get("value") else {
        return Err(invalid(format!(
            "{SEARCH_RESULT}: \"{label}.value\" must be a string"
        )));
    };
    let length = utf16_length(text);
    if length > MAX_FACET_VALUE_LENGTH {
        return Err(invalid(format!(
            "{SEARCH_RESULT}: \"{label}.value\" exceeds maximum length of {MAX_FACET_VALUE_LENGTH}"
        ))
        .with_detail("length", Value::from(length))
        .with_detail("limit", Value::from(MAX_FACET_VALUE_LENGTH)));
    }
    let Some(count) = count_of(bucket.get("count")) else {
        return Err(invalid(format!(
            "{SEARCH_RESULT}: \"{label}.count\" must be a non-negative integer"
        )));
    };
    Ok((text.clone(), count))
}

fn field_count_within(fields: &Map, label: &str) -> ClusterResult<()> {
    if fields.len() > MAX_FACET_FIELDS {
        return Err(invalid(format!(
            "{SEARCH_RESULT}: \"{label}\" exceeds maximum field count of {MAX_FACET_FIELDS}"
        ))
        .with_detail("length", Value::from(fields.len()))
        .with_detail("limit", Value::from(MAX_FACET_FIELDS)));
    }
    Ok(())
}

fn facets_of(value: Option<&Value>) -> ClusterResult<Option<FacetBuckets>> {
    let fields = match value {
        Some(Value::Null) => return Ok(None),
        Some(Value::Object(fields)) => fields,
        _ => {
            return Err(invalid(format!(
                "{SEARCH_RESULT}: \"facets\" must be an object or null"
            )));
        }
    };
    field_count_within(fields, "facets")?;
    let mut facets = Vec::with_capacity(fields.len());
    for (field, buckets) in fields.iter() {
        if field.is_empty() {
            return Err(invalid(format!(
                "{SEARCH_RESULT}: each \"facets\" key must be a non-empty string"
            )));
        }
        let Value::Array(buckets) = buckets else {
            return Err(invalid(format!(
                "{SEARCH_RESULT}: \"facets.{field}\" must be an array"
            )));
        };
        if buckets.len() > MAX_FACET_BUCKETS {
            return Err(invalid(format!(
                "{SEARCH_RESULT}: \"facets.{field}\" exceeds maximum bucket count of {MAX_FACET_BUCKETS}"
            ))
            .with_detail("length", Value::from(buckets.len()))
            .with_detail("limit", Value::from(MAX_FACET_BUCKETS)));
        }
        let counted = buckets
            .iter()
            .enumerate()
            .map(|(at, bucket)| facet_bucket(bucket, &format!("facets.{field}[{at}]")))
            .collect::<ClusterResult<Vec<_>>>()?;
        facets.push((field.clone(), counted));
    }
    Ok(Some(facets))
}

fn facet_error_bounds_of(value: Option<&Value>) -> ClusterResult<Option<BTreeMap<String, u64>>> {
    if absent(value) {
        return Ok(None);
    }
    let Some(Value::Object(fields)) = value else {
        return Err(invalid(format!(
            "{SEARCH_RESULT}: \"facetErrorBounds\" must be an object or null"
        )));
    };
    field_count_within(fields, "facetErrorBounds")?;
    let mut bounds = BTreeMap::new();
    for (field, bound) in fields.iter() {
        let Some(bound) = count_of(Some(bound)) else {
            return Err(invalid(format!(
                "{SEARCH_RESULT}: \"facetErrorBounds.{field}\" must be a non-negative integer"
            )));
        };
        bounds.insert(field.clone(), bound);
    }
    Ok(Some(bounds))
}

fn groups_of(value: Option<&Value>) -> ClusterResult<Option<Vec<WireGroupEntry>>> {
    if absent(value) {
        return Ok(None);
    }
    let Some(Value::Array(entries)) = value else {
        return Err(invalid(format!(
            "{SEARCH_RESULT}: \"groups\" must be an array or null"
        )));
    };
    if entries.len() > MAX_GROUPS_PER_RESPONSE {
        return Err(invalid(format!(
            "{SEARCH_RESULT}: \"groups\" exceeds maximum length of {MAX_GROUPS_PER_RESPONSE}"
        ))
        .with_detail("length", Value::from(entries.len()))
        .with_detail("limit", Value::from(MAX_GROUPS_PER_RESPONSE)));
    }
    let mut groups = Vec::with_capacity(entries.len());
    for (at, entry) in entries.iter().enumerate() {
        let Value::Object(entry) = entry else {
            return Err(invalid(format!(
                "{SEARCH_RESULT}: \"groups[{at}]\" must hold a values object"
            )));
        };
        let Some(Value::Object(values)) = entry.get("values") else {
            return Err(invalid(format!(
                "{SEARCH_RESULT}: \"groups[{at}]\" must hold a values object"
            )));
        };
        if values.len() > MAX_FACET_FIELDS {
            return Err(invalid(format!(
                "{SEARCH_RESULT}: \"groups[{at}].values\" exceeds maximum field count of {MAX_FACET_FIELDS}"
            )));
        }
        groups.push(WireGroupEntry {
            values: values.clone(),
            scored: scored_list(entry.get("scored"), &format!("groups[{at}].scored"))?,
        });
    }
    Ok(Some(groups))
}

fn context_id_of(value: Option<&Value>) -> ClusterResult<Option<String>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(context_id))
            if !context_id.is_empty()
                && utf16_length(context_id) <= MAX_SEARCH_CONTEXT_ID_LENGTH =>
        {
            Ok(Some(context_id.clone()))
        }
        Some(_) => Err(invalid(format!(
            "{SEARCH_RESULT}: \"contextId\" must be a string of 1 to {MAX_SEARCH_CONTEXT_ID_LENGTH} characters, or null"
        ))),
    }
}

pub(crate) fn validate_search_result_payload(decoded: Map) -> ClusterResult<SearchAnswer> {
    let Some(Value::Array(results)) = decoded.get("results") else {
        return Err(invalid(format!(
            "{SEARCH_RESULT}: \"results\" must be an array"
        )));
    };
    let results = results
        .iter()
        .enumerate()
        .map(|(at, result)| partition_result(result, &format!("results[{at}]")))
        .collect::<ClusterResult<Vec<_>>>()?;
    Ok(SearchAnswer {
        results,
        facets: facets_of(decoded.get("facets"))?,
        facet_error_bounds: facet_error_bounds_of(decoded.get("facetErrorBounds"))?,
        groups: groups_of(decoded.get("groups"))?,
        context_id: context_id_of(decoded.get("contextId"))?,
    })
}
