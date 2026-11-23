use narsil::{
    Bm25FieldParams, Bm25Params, Pin, QueryParams, ScoringMode, SearchMode, TermMatch, Value,
};

use super::payload::{invalid, string_field, string_list};
use super::sort::sort_fields;
use super::wire_options::{facets, group, hybrid, vector};
use super::wire_values::{SEARCH_PAYLOAD, flag, number, object, text, whole, wrong};
use crate::constants::{MAX_FIELD_NAME_LENGTH, MAX_FIELDS_LIST, MAX_QUERY_LIMIT, MAX_TERM_LENGTH};
use crate::error::{ClusterResult, codes};

pub(super) struct WireParams {
    pub(super) params: QueryParams,
    pub(super) index_bm25: Option<Bm25Params>,
    pub(super) analysis_generation: u64,
    pub(super) rescore_window: Option<usize>,
}

fn bm25(value: Option<&Value>, label: &str) -> ClusterResult<Option<Bm25Params>> {
    let Some(fields) = object(value, label)? else {
        return Ok(None);
    };
    let per_field = match object(fields.get("fields"), &format!("{label}.fields"))? {
        None => None,
        Some(named) => {
            let mut parsed = Vec::with_capacity(named.len());
            for (name, entry) in named.iter() {
                let entry_label = format!("{label}.fields.{name}");
                let entry = object(Some(entry), &entry_label)?
                    .cloned()
                    .unwrap_or_default();
                parsed.push((
                    name.clone(),
                    Bm25FieldParams {
                        k1: number(entry.get("k1"), &format!("{entry_label}.k1"))?,
                        b: number(entry.get("b"), &format!("{entry_label}.b"))?,
                    },
                ));
            }
            Some(parsed)
        }
    };
    Ok(Some(Bm25Params {
        k1: number(fields.get("k1"), &format!("{label}.k1"))?,
        b: number(fields.get("b"), &format!("{label}.b"))?,
        fields: per_field,
    }))
}

fn scoring(value: Option<&Value>) -> ClusterResult<Option<ScoringMode>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(name)) if name == "local" => Ok(Some(ScoringMode::Local)),
        Some(Value::String(name)) if name == "dfs" => Ok(Some(ScoringMode::Dfs)),
        Some(Value::String(name)) if name == "broadcast" => Ok(Some(ScoringMode::Broadcast)),
        Some(_) => Err(wrong(
            codes::SEARCH_INVALID_MODE,
            "scoring",
            "must be one of: local, dfs, broadcast",
        )),
    }
}

fn term_match(value: Option<&Value>) -> ClusterResult<Option<TermMatch>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(name)) if name == "all" => Ok(Some(TermMatch::All)),
        Some(Value::String(name)) if name == "any" => Ok(Some(TermMatch::Any)),
        Some(Value::Number(count))
            if count.fract() == 0.0 && *count >= 1.0 && *count <= f64::from(u32::MAX) =>
        {
            Ok(Some(TermMatch::AtLeast(*count as u32)))
        }
        Some(_) => Err(wrong(
            codes::SEARCH_INVALID_MODE,
            "termMatch",
            "must be \"all\", \"any\", or a count",
        )),
    }
}

fn search_mode(value: Option<&Value>) -> ClusterResult<Option<SearchMode>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(name)) if name == "fulltext" => Ok(Some(SearchMode::Fulltext)),
        Some(Value::String(name)) if name == "vector" => Ok(Some(SearchMode::Vector)),
        Some(Value::String(name)) if name == "hybrid" => Ok(Some(SearchMode::Hybrid)),
        Some(_) => Err(wrong(
            codes::SEARCH_INVALID_MODE,
            "mode",
            "must be one of: fulltext, vector, hybrid",
        )),
    }
}

fn boost(value: Option<&Value>) -> ClusterResult<Option<Vec<(String, f64)>>> {
    let Some(fields) = object(value, "boost")? else {
        return Ok(None);
    };
    let mut boosts = Vec::with_capacity(fields.len());
    for (field, multiplier) in fields.iter() {
        let Some(multiplier) = number(Some(multiplier), &format!("boost.{field}"))? else {
            return Err(wrong(
                codes::CONFIG_INVALID,
                &format!("boost.{field}"),
                "must be a finite number",
            ));
        };
        boosts.push((field.clone(), multiplier));
    }
    Ok(Some(boosts))
}

fn pins(value: Option<&Value>) -> ClusterResult<Option<Vec<Pin>>> {
    let items = match value {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Array(items)) => items,
        Some(_) => {
            return Err(wrong(
                codes::CONFIG_INVALID,
                "pinned",
                "must be an array or null",
            ));
        }
    };
    let mut pinned = Vec::with_capacity(items.len());
    for (at, item) in items.iter().enumerate() {
        let label = format!("pinned[{at}]");
        let Some(entry) = object(Some(item), &label)? else {
            return Err(wrong(codes::CONFIG_INVALID, &label, "must be an object"));
        };
        let doc_id = text(entry.get("docId"), &format!("{label}.docId"))?
            .ok_or_else(|| wrong(codes::CONFIG_INVALID, &label, "must carry a docId"))?;
        let position = whole(
            entry.get("position"),
            &format!("{label}.position"),
            MAX_QUERY_LIMIT,
        )?
        .ok_or_else(|| wrong(codes::CONFIG_INVALID, &label, "must carry a position"))?;
        pinned.push(Pin {
            doc_id: doc_id.to_string(),
            position: position as usize,
        });
    }
    Ok(Some(pinned))
}

fn generation(value: Option<&Value>) -> ClusterResult<u64> {
    match value {
        None | Some(Value::Null) => Ok(0),
        Some(Value::Number(number))
            if number.fract() == 0.0
                && (0.0..=crate::constants::MAX_SAFE_INTEGER as f64).contains(number) =>
        {
            Ok(*number as u64)
        }
        Some(_) => Err(invalid(
            codes::CONFIG_INVALID,
            format!(
                "Invalid {SEARCH_PAYLOAD}: \"analysisGeneration\" must be a non-negative integer"
            ),
        )),
    }
}

pub(super) fn wire_params(
    value: Option<&Value>,
    facet_shard_size: Option<usize>,
) -> ClusterResult<WireParams> {
    let Some(Value::Object(fields)) = value else {
        return Err(invalid(
            codes::CONFIG_INVALID,
            format!("Invalid {SEARCH_PAYLOAD}: \"params\" must be an object"),
        ));
    };
    let term = match fields.get("term") {
        None | Some(Value::Null) => None,
        term => Some(string_field(
            term,
            "params.term",
            MAX_TERM_LENGTH,
            codes::CONFIG_INVALID,
        )?),
    };
    let searched_fields = match fields.get("fields") {
        None | Some(Value::Null) => None,
        listed => Some(string_list(
            listed,
            "params.fields",
            MAX_FIELDS_LIST,
            MAX_FIELD_NAME_LENGTH,
            codes::SEARCH_INVALID_FIELD,
        )?),
    };
    let sort = sort_fields(fields.get("sort"), SEARCH_PAYLOAD, "params.sort")?;
    let facet_size =
        whole(fields.get("facetSize"), "facetSize", MAX_QUERY_LIMIT)?.map(|size| size as usize);
    let (vector, rescore_window) = vector(fields.get("vector"))?;
    let limit = whole(fields.get("limit"), "limit", MAX_QUERY_LIMIT)?.ok_or_else(|| {
        wrong(
            codes::CONFIG_INVALID,
            "limit",
            "must be a non-negative integer",
        )
    })?;
    let offset = whole(fields.get("offset"), "offset", MAX_QUERY_LIMIT)?.ok_or_else(|| {
        wrong(
            codes::CONFIG_INVALID,
            "offset",
            "must be a non-negative integer",
        )
    })?;
    let params = QueryParams {
        term,
        fields: searched_fields,
        filters: match fields.get("filters") {
            None | Some(Value::Null) => None,
            Some(filters) => Some(filters.clone()),
        },
        boost: boost(fields.get("boost"))?,
        bm25: bm25(fields.get("bm25"), "bm25")?,
        scoring: scoring(fields.get("scoring"))?,
        min_score: number(fields.get("threshold"), "threshold")?,
        term_match: term_match(fields.get("termMatch"))?,
        tolerance: whole(fields.get("tolerance"), "tolerance", f64::from(u32::MAX))?
            .map(|tolerance| tolerance as u32),
        prefix_length: whole(
            fields.get("prefixLength"),
            "prefixLength",
            f64::from(u32::MAX),
        )?
        .map(|length| length as u32),
        prefix: flag(fields.get("prefix"), "prefix")?,
        partial_words: flag(fields.get("partialWords"), "partialWords")?,
        exact: flag(fields.get("exact"), "exact")?,
        facets: facets(fields.get("facets"), facet_shard_size.or(facet_size))?,
        sort: (!sort.is_empty()).then_some(sort),
        group: group(fields.get("group"))?,
        limit: Some(limit as usize),
        offset: Some(offset as usize),
        search_after: text(fields.get("searchAfter"), "searchAfter")?.map(str::to_string),
        pinned: pins(fields.get("pinned"))?,
        mode: search_mode(fields.get("mode"))?,
        vector,
        hybrid: hybrid(fields.get("hybrid"))?,
        include_scores: flag(fields.get("includeScores"), "includeScores")?,
        ..QueryParams::default()
    };
    Ok(WireParams {
        params,
        index_bm25: bm25(fields.get("indexBm25"), "indexBm25")?,
        analysis_generation: generation(fields.get("analysisGeneration"))?,
        rescore_window,
    })
}
