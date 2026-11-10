use super::params::{QueryParams, SortField, SortMode};
use crate::config::validate_bm25_params;
use crate::engine::index::IndexState;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::ordering::SORT_VALUE_MAX_CODE_POINTS;
use crate::schema::{BaseType, FieldType, parse_field_type};
use crate::value::number_to_text;

const TYPE_SEPARATOR: char = ':';

fn invalid_field(message: String) -> NarsilError {
    NarsilError::new(ErrorCode::SEARCH_INVALID_FIELD, message)
}

fn undeclared_on_strict_index(field: &str, option: &str) -> NarsilError {
    invalid_field(format!(
        "The index is strict and its schema declares no field \"{field}\", so no stored document has a value in that field for this {option}"
    ))
}

fn is_strict(index: &IndexState) -> bool {
    index.config().strict == Some(true)
}

fn is_geopoint_or_vector(field_type: &FieldType) -> bool {
    matches!(field_type.base, BaseType::Geopoint | BaseType::Vector)
}

fn with_sortable_option(field_type: &FieldType) -> String {
    let name = &field_type.name;
    let base_length = name.find(TYPE_SEPARATOR).unwrap_or(name.len());
    let widened = format!(
        "{}{TYPE_SEPARATOR}sortable{}",
        &name[..base_length],
        &name[base_length..]
    );
    parse_field_type(&widened, "").map_or(widened, |parsed| parsed.name)
}

fn require_sort_mode(entry: &SortField, field_type: Option<&FieldType>) -> Result<()> {
    let Some(mode @ (SortMode::Avg | SortMode::Median)) = entry.mode else {
        return Ok(());
    };
    let Some(field_type) = field_type else {
        return Ok(());
    };
    if matches!(field_type.base, BaseType::Number | BaseType::NumberList) {
        return Ok(());
    }
    let mode_name = if mode == SortMode::Avg {
        "avg"
    } else {
        "median"
    };
    Err(invalid_field(format!(
        "The engine applies the \"{mode_name}\" mode to a number field alone, and \"{}\" is a {} field",
        entry.field, field_type.name
    )))
}

pub(crate) fn require_sortable_fields(
    index: &IndexState,
    sort: Option<&[SortField]>,
) -> Result<()> {
    let strict = is_strict(index);
    for entry in sort.unwrap_or(&[]) {
        let field_type = index.schema.field_type(&entry.field);
        if strict && field_type.is_none() {
            return Err(undeclared_on_strict_index(&entry.field, "sort"));
        }
        require_sort_mode(entry, field_type)?;
        let Some(field_type) = field_type else {
            continue;
        };
        if field_type.base.is_string_valued() && !field_type.sortable {
            return Err(invalid_field(format!(
                "The engine sorts by text field \"{}\" only where its type includes \"sortable\", as in \"{}\", because it keeps up to the first {SORT_VALUE_MAX_CODE_POINTS} code points of every document's value in memory to sort by a text field",
                entry.field,
                with_sortable_option(field_type)
            )));
        }
        if is_geopoint_or_vector(field_type) {
            return Err(invalid_field(format!(
                "The engine sorts by a number, boolean, enum, or sortable text field, and \"{}\" is a {} field",
                entry.field, field_type.name
            )));
        }
    }
    Ok(())
}

fn require_boostable_fields(index: &IndexState, boost: &[(String, f64)]) -> Result<()> {
    let mut seen: Vec<&str> = Vec::with_capacity(boost.len());
    for (field, _) in boost {
        if seen.contains(&field.as_str()) {
            continue;
        }
        seen.push(field);
        let weight = boost
            .iter()
            .rev()
            .find(|(held, _)| held == field)
            .map_or(f64::NAN, |(_, weight)| *weight);
        match index.schema.field_type(field) {
            None => {
                return Err(invalid_field(format!(
                    "The engine boosts a text field that the schema declares, and the schema declares no field \"{field}\""
                )));
            }
            Some(field_type) if !field_type.base.is_word_indexed() => {
                return Err(invalid_field(format!(
                    "The engine boosts a text field alone, and the schema declares field \"{field}\" as \"{}\"",
                    field_type.name
                )));
            }
            Some(_) => {}
        }
        if !weight.is_finite() {
            return Err(NarsilError::new(
                ErrorCode::CONFIG_INVALID,
                format!(
                    "The boost on field \"{field}\" must be a finite number, and this query sets {}",
                    number_to_text(weight)
                ),
            ));
        }
    }
    Ok(())
}

fn require_facetable_fields(index: &IndexState, fields: &[&str]) -> Result<()> {
    let strict = is_strict(index);
    for field in fields {
        let field_type = index.schema.field_type(field);
        if strict && field_type.is_none() {
            return Err(undeclared_on_strict_index(field, "facet"));
        }
        if let Some(field_type) = field_type.filter(|field_type| is_geopoint_or_vector(field_type))
        {
            return Err(invalid_field(format!(
                "The engine counts the values of a text, number, boolean, or enum field, and the schema declares field \"{field}\" as \"{}\"",
                field_type.name
            )));
        }
    }
    Ok(())
}

fn require_groupable_fields(index: &IndexState, fields: &[String]) -> Result<()> {
    let strict = is_strict(index);
    for field in fields {
        let field_type = index.schema.field_type(field);
        if strict && field_type.is_none() {
            return Err(undeclared_on_strict_index(field, "group"));
        }
        if let Some(field_type) =
            field_type.filter(|field_type| field_type.base == BaseType::Vector)
        {
            return Err(invalid_field(format!(
                "The engine groups hits by a text, number, boolean, enum, or geopoint field, and the schema declares field \"{field}\" as \"{}\"",
                field_type.name
            )));
        }
    }
    Ok(())
}

pub(crate) fn distinct_facet_fields(params: &QueryParams) -> Vec<&str> {
    let mut fields: Vec<&str> = Vec::new();
    for (field, _) in params.facets.as_deref().unwrap_or(&[]) {
        if !fields.contains(&field.as_str()) {
            fields.push(field);
        }
    }
    fields
}

pub(crate) fn require_usable_query_fields(index: &IndexState, params: &QueryParams) -> Result<()> {
    if let Some(bm25) = &params.bm25 {
        validate_bm25_params(bm25, &index.schema, ErrorCode::SEARCH_INVALID_FIELD, true)?;
    }
    if let Some(boost) = &params.boost {
        require_boostable_fields(index, boost)?;
    }
    if params.facets.is_some() {
        require_facetable_fields(index, &distinct_facet_fields(params))?;
    }
    if let Some(group) = params
        .group
        .as_ref()
        .filter(|group| !group.fields.is_empty())
    {
        require_groupable_fields(index, &group.fields)?;
    }
    Ok(())
}
