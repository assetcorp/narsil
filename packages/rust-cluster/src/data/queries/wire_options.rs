use narsil::{
    FacetSpec, GroupConfig, HybridConfig, HybridStrategy, Metric, SortDirection, Value, VectorQuery,
};

use super::payload::{string_field, string_list};
use super::wire_values::{number, object, text, whole, wrong};
use crate::constants::{
    MAX_FACET_BUCKETS, MAX_FIELD_NAME_LENGTH, MAX_FIELDS_LIST, MAX_QUERY_LIMIT,
};
use crate::error::{ClusterResult, codes};

pub(super) fn group(value: Option<&Value>) -> ClusterResult<Option<GroupConfig>> {
    let Some(fields) = object(value, "group")? else {
        return Ok(None);
    };
    let grouped = string_list(
        fields.get("fields"),
        "params.group.fields",
        MAX_FIELDS_LIST,
        MAX_FIELD_NAME_LENGTH,
        codes::SEARCH_INVALID_FIELD,
    )?;
    Ok(Some(GroupConfig {
        fields: grouped,
        max_per_group: whole(
            fields.get("maxPerGroup"),
            "group.maxPerGroup",
            MAX_QUERY_LIMIT,
        )?
        .map(|count| count as usize),
        limit: whole(fields.get("limit"), "group.limit", MAX_QUERY_LIMIT)?
            .map(|count| count as usize),
        reduce: None,
    }))
}

fn facet_range(value: &Value, label: &str) -> ClusterResult<(f64, f64)> {
    let bounds = object(Some(value), label)?;
    let from = bounds.and_then(|bounds| bounds.get("from"));
    let to = bounds.and_then(|bounds| bounds.get("to"));
    match (number(from, label), number(to, label)) {
        (Ok(Some(from)), Ok(Some(to))) => Ok((from, to)),
        _ => Err(wrong(
            codes::CONFIG_INVALID,
            label,
            "must hold a numeric from and to",
        )),
    }
}

pub(super) fn facets(
    value: Option<&Value>,
    limit: Option<usize>,
) -> ClusterResult<Option<Vec<(String, FacetSpec)>>> {
    let items = match value {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Array(items)) if items.is_empty() => return Ok(None),
        Some(Value::Array(items)) => items,
        Some(_) => {
            return Err(wrong(
                codes::SEARCH_INVALID_FIELD,
                "facets",
                "must be an array or null",
            ));
        }
    };
    let mut specs = Vec::with_capacity(items.len());
    for (at, item) in items.iter().enumerate() {
        let label = format!("facets[{at}]");
        let Some(entry) = object(Some(item), &label)? else {
            return Err(wrong(codes::CONFIG_INVALID, &label, "must be an object"));
        };
        let field = string_field(
            entry.get("field"),
            &format!("params.{label}.field"),
            MAX_FIELD_NAME_LENGTH,
            codes::SEARCH_INVALID_FIELD,
        )?;
        let sort = match text(entry.get("sort"), &format!("{label}.sort"))? {
            None => None,
            Some("asc") => Some(SortDirection::Asc),
            Some("desc") => Some(SortDirection::Desc),
            Some(_) => {
                return Err(wrong(
                    codes::SEARCH_INVALID_MODE,
                    &format!("{label}.sort"),
                    "must be one of: asc, desc",
                ));
            }
        };
        let ranges = match entry.get("ranges") {
            None | Some(Value::Null) => None,
            Some(Value::Array(ranges)) => Some(
                ranges
                    .iter()
                    .enumerate()
                    .map(|(range_at, range)| {
                        facet_range(range, &format!("{label}.ranges[{range_at}]"))
                    })
                    .collect::<ClusterResult<Vec<_>>>()?,
            ),
            Some(_) => {
                return Err(wrong(
                    codes::CONFIG_INVALID,
                    &format!("{label}.ranges"),
                    "must be an array or null",
                ));
            }
        };
        let counts_every_value = ranges.is_some() || sort == Some(SortDirection::Asc);
        let spec = FacetSpec {
            limit: match counts_every_value {
                true => Some(MAX_FACET_BUCKETS),
                false => limit,
            },
            sort,
            ranges,
        };
        specs.push((field, spec));
    }
    Ok(Some(specs))
}

fn metric(value: Option<&Value>) -> ClusterResult<Option<Metric>> {
    match text(value, "vector.metric")? {
        None => Ok(None),
        Some("cosine") => Ok(Some(Metric::Cosine)),
        Some("dotProduct") => Ok(Some(Metric::DotProduct)),
        Some("euclidean") => Ok(Some(Metric::Euclidean)),
        Some(_) => Err(wrong(
            codes::CONFIG_INVALID,
            "vector.metric",
            "must be one of: cosine, dotProduct, euclidean",
        )),
    }
}

pub(super) fn vector(value: Option<&Value>) -> ClusterResult<(Option<VectorQuery>, Option<usize>)> {
    let Some(fields) = object(value, "vector")? else {
        return Ok((None, None));
    };
    let field = string_field(
        fields.get("field"),
        "params.vector.field",
        MAX_FIELD_NAME_LENGTH,
        codes::SEARCH_INVALID_FIELD,
    )?;
    let components = match fields.get("value") {
        None | Some(Value::Null) => None,
        Some(Value::Array(items)) => Some(
            items
                .iter()
                .enumerate()
                .map(|(at, item)| match item {
                    Value::Number(component) if component.is_finite() => Ok(*component as f32),
                    _ => Err(wrong(
                        codes::CONFIG_INVALID,
                        &format!("vector.value[{at}]"),
                        "must be a finite number",
                    )),
                })
                .collect::<ClusterResult<Vec<f32>>>()?,
        ),
        Some(_) => {
            return Err(wrong(
                codes::CONFIG_INVALID,
                "vector.value",
                "must be an array of finite numbers or null",
            ));
        }
    };
    let query = VectorQuery {
        field,
        value: components,
        text: text(fields.get("text"), "vector.text")?.map(str::to_string),
        similarity: number(fields.get("similarity"), "vector.similarity")?,
        metric: metric(fields.get("metric"))?,
        ef_search: whole(
            fields.get("efSearch"),
            "vector.efSearch",
            f64::from(u32::MAX),
        )?
        .map(|ef| ef as u32),
        oversample: number(fields.get("oversample"), "vector.oversample")?,
    };
    let rescore_window = whole(
        fields.get("rescoreWindow"),
        "vector.rescoreWindow",
        MAX_QUERY_LIMIT,
    )?
    .map(|window| window as usize);
    Ok((Some(query), rescore_window))
}

pub(super) fn hybrid(value: Option<&Value>) -> ClusterResult<Option<HybridConfig>> {
    let Some(fields) = object(value, "hybrid")? else {
        return Ok(None);
    };
    let strategy = match text(fields.get("strategy"), "hybrid.strategy")? {
        None => None,
        Some("rrf") => Some(HybridStrategy::Rrf),
        Some("linear") => Some(HybridStrategy::Linear),
        Some(_) => {
            return Err(wrong(
                codes::SEARCH_INVALID_MODE,
                "hybrid.strategy",
                "must be one of: rrf, linear",
            ));
        }
    };
    Ok(Some(HybridConfig {
        strategy,
        k: number(fields.get("k"), "hybrid.k")?,
        alpha: number(fields.get("alpha"), "hybrid.alpha")?,
        depth: whole(fields.get("depth"), "hybrid.depth", MAX_QUERY_LIMIT)?
            .map(|depth| depth as usize),
    }))
}
