use narsil::{
    DocumentProjection, ErrorCode, FacetSpec, GroupConfig, HighlightConfig, Pin, SortDirection,
    SortField, SortMode, Value,
};

use crate::errors::ServerError;
use crate::search::reader::{
    Converted, Fields, details_of, entries_of, refusal, shown, size_of, strings_of, whole_count,
};

pub(crate) const DIRECTIONS: [(&str, SortDirection); 2] =
    [("asc", SortDirection::Asc), ("desc", SortDirection::Desc)];
const SORT_MODES: [(&str, SortMode); 4] = [
    ("min", SortMode::Min),
    ("max", SortMode::Max),
    ("avg", SortMode::Avg),
    ("median", SortMode::Median),
];

fn invalid_sort(message: String) -> ServerError {
    refusal(ErrorCode::SEARCH_INVALID_MODE, message)
}

fn direction_on(field: &str, direction: Option<&Value>) -> Converted<SortDirection> {
    let found = direction.and_then(Value::as_str).and_then(|text| {
        DIRECTIONS
            .iter()
            .find(|(name, _)| *name == text)
            .map(|(_, direction)| *direction)
    });
    found.ok_or_else(|| {
        let given = direction.map_or_else(|| "undefined".to_string(), shown);
        invalid_sort(format!(
            "A sort direction is \"asc\" or \"desc\", and the direction on \"{field}\" is \"{given}\""
        ))
    })
}

fn mode_on(field: &str, mode: Option<&Value>) -> Converted<Option<SortMode>> {
    let Some(mode) = mode.filter(|mode| !mode.is_null()) else {
        return Ok(None);
    };
    let found = mode.as_str().and_then(|text| {
        SORT_MODES
            .iter()
            .find(|(name, _)| *name == text)
            .map(|(_, mode)| *mode)
    });
    found.map(Some).ok_or_else(|| {
        invalid_sort(format!(
            "A sort mode is one of \"min\", \"max\", \"avg\", \"median\", and the mode on \"{field}\" is \"{}\"",
            shown(mode)
        ))
    })
}

pub(crate) fn sort_fields(sort: &Value) -> Converted<Vec<SortField>> {
    match sort {
        Value::Object(fields) => fields
            .iter()
            .map(|(field, direction)| {
                Ok(SortField {
                    direction: direction_on(field, Some(direction))?,
                    field: field.clone(),
                    mode: None,
                })
            })
            .collect(),
        Value::Array(entries) => entries
            .iter()
            .map(|entry| {
                let Some(Value::String(field)) =
                    entry.as_object().and_then(|entry| entry.get("field"))
                else {
                    return Err(invalid_sort(
                        "Every entry of \"sort\" must name a field".to_string(),
                    ));
                };
                let entry = entry.as_object();
                Ok(SortField {
                    direction: direction_on(field, entry.and_then(|entry| entry.get("direction")))?,
                    mode: mode_on(field, entry.and_then(|entry| entry.get("mode")))?,
                    field: field.clone(),
                })
            })
            .collect(),
        Value::String(text) => match text.chars().next() {
            None => Ok(Vec::new()),
            Some(first) => Err(invalid_sort(format!(
                "A sort direction is \"asc\" or \"desc\", and the direction on \"0\" is \"{first}\""
            ))),
        },
        _ => Ok(Vec::new()),
    }
}

fn ranges(spec: &Fields<'_>) -> Converted<Option<Vec<(f64, f64)>>> {
    let Some(ranges) = spec.get("ranges") else {
        return Ok(None);
    };
    let wrong = || {
        spec.wrong(
            "ranges",
            ErrorCode::CONFIG_INVALID,
            "a list of {\"from\", \"to\"} number pairs",
        )
    };
    let Value::Array(ranges) = ranges else {
        return Err(wrong());
    };
    ranges
        .iter()
        .map(|range| {
            let bound = |name: &str| {
                range
                    .as_object()
                    .and_then(|range| range.get(name))
                    .and_then(Value::as_f64)
            };
            match (bound("from"), bound("to")) {
                (Some(from), Some(to)) => Ok((from, to)),
                _ => Err(wrong()),
            }
        })
        .collect::<Converted<Vec<_>>>()
        .map(Some)
}

pub(crate) fn facet_specs(facets: &Value) -> Converted<Vec<(String, FacetSpec)>> {
    let entries = entries_of(facets).ok_or_else(|| {
        refusal(
            ErrorCode::CONFIG_INVALID,
            "Field \"facets\" must be an object keyed by field name",
        )
    })?;
    let empty = narsil::Map::new();
    entries
        .into_iter()
        .map(|(field, spec)| {
            let map = spec.as_object().unwrap_or(&empty);
            let spec = Fields::new(map, format!("facets.{field}"));
            let facet = FacetSpec {
                limit: spec.count("limit", ErrorCode::CONFIG_INVALID)?,
                sort: spec.choice("sort", ErrorCode::CONFIG_INVALID, &DIRECTIONS)?,
                ranges: ranges(&spec)?,
            };
            Ok((field, facet))
        })
        .collect()
}

pub(crate) fn group_config(group: &Value) -> Converted<GroupConfig> {
    let Value::Object(group) = group else {
        return Err(refusal(
            ErrorCode::CONFIG_INVALID,
            "Field \"group\" must be an object",
        ));
    };
    let fields = Fields::new(group, "group");
    Ok(GroupConfig {
        fields: fields
            .strings("fields", ErrorCode::CONFIG_INVALID)?
            .unwrap_or_default(),
        max_per_group: fields.count("maxPerGroup", ErrorCode::CONFIG_INVALID)?,
        limit: fields
            .number("limit", ErrorCode::CONFIG_INVALID)?
            .filter(|limit| *limit >= 0.0)
            .map(whole_count),
        reduce: None,
    })
}

pub(crate) fn highlight_config(highlight: &Value) -> Converted<HighlightConfig> {
    let Value::Object(highlight) = highlight else {
        return Err(refusal(
            ErrorCode::CONFIG_INVALID,
            "Field \"highlight\" must be an object",
        ));
    };
    let fields = Fields::new(highlight, "highlight");
    Ok(HighlightConfig {
        fields: fields
            .strings("fields", ErrorCode::CONFIG_INVALID)?
            .ok_or_else(|| {
                fields.wrong("fields", ErrorCode::CONFIG_INVALID, "a list of strings")
            })?,
        pre_tag: fields.string("preTag", ErrorCode::CONFIG_INVALID)?,
        post_tag: fields.string("postTag", ErrorCode::CONFIG_INVALID)?,
        max_snippet_length: fields.count("maxSnippetLength", ErrorCode::CONFIG_INVALID)?,
    })
}

pub(crate) fn pins(pinned: &Value) -> Converted<Vec<Pin>> {
    let wrong = || {
        refusal(
            ErrorCode::CONFIG_INVALID,
            "Field \"pinned\" must be a list of {\"docId\", \"position\"} objects",
        )
    };
    let Value::Array(entries) = pinned else {
        return Err(wrong());
    };
    entries
        .iter()
        .map(|entry| {
            let Some(entry) = entry.as_object() else {
                return Err(wrong());
            };
            let Some(Value::String(doc_id)) = entry.get("docId") else {
                return Err(wrong());
            };
            let position = entry.get("position").and_then(size_of).ok_or_else(|| {
                refusal(
                    ErrorCode::CONFIG_INVALID,
                    "A pinned document position must be a non-negative integer",
                )
                .with_details(details_of(vec![
                    ("docId", Value::String(doc_id.clone())),
                    (
                        "position",
                        entry.get("position").cloned().unwrap_or(Value::Null),
                    ),
                ]))
            })?;
            Ok(Pin {
                doc_id: doc_id.clone(),
                position,
            })
        })
        .collect()
}

fn projection_paths(option: &str, given: Option<&Value>) -> Converted<Option<Vec<String>>> {
    let Some(given) = given else {
        return Ok(None);
    };
    let Value::Array(entries) = given else {
        return Err(refusal(
            ErrorCode::SEARCH_INVALID_FIELD,
            format!("The \"{option}\" option takes an array of field paths"),
        ));
    };
    if let Some(at) = entries.iter().position(|entry| entry.as_str().is_none()) {
        return Err(refusal(
            ErrorCode::SEARCH_INVALID_FIELD,
            format!(
                "The \"{option}\" option takes field paths as strings, and entry {at} is not a string"
            ),
        ));
    }
    Ok(strings_of(given))
}

fn projection_vectors(given: Option<&Value>) -> Converted<Option<bool>> {
    match given {
        None => Ok(None),
        Some(Value::Bool(vectors)) => Ok(Some(*vectors)),
        Some(_) => Err(refusal(
            ErrorCode::SEARCH_INVALID_FIELD,
            "The \"document.vectors\" option takes true or false",
        )),
    }
}

pub(crate) fn projection(document: &Value) -> Converted<DocumentProjection> {
    match document {
        Value::Bool(true) => Ok(DocumentProjection::All),
        Value::Bool(false) => Ok(DocumentProjection::None),
        Value::Object(fields) => {
            let member = |key: &str| fields.get(key).filter(|given| !given.is_null());
            Ok(DocumentProjection::Fields {
                include: projection_paths("document.include", member("include"))?,
                exclude: projection_paths("document.exclude", member("exclude"))?,
                vectors: projection_vectors(member("vectors"))?,
            })
        }
        _ => Err(refusal(
            ErrorCode::SEARCH_INVALID_FIELD,
            "The \"document\" option takes true, false, or an object that lists field paths",
        )),
    }
}
