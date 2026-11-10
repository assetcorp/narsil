use std::collections::HashSet;

use super::{
    BooleanColumn, EnumColumn, FieldLengthColumn, GeopointColumn, PartialWords, PatternColumn,
    SurfaceForms, ValueColumn,
};
use crate::error::Result;
use crate::format::fields::Fields;
use crate::format::segment_checks::{
    require_below, require_non_zero, require_offsets, require_ordinals, require_runs_ascend,
    require_spelling_entries_ascend, require_strictly_ascending, require_strictly_ascending_within,
    require_utf8_entries, require_values_ascend_without_nan, require_within,
};
use crate::util::bytes::{f64_list, u32_list};
use crate::value::Value;

const LATITUDE_LIMIT: f64 = 90.0;
const LONGITUDE_LIMIT: f64 = 180.0;
const CODE_POINTS_PER_RUN: usize = 3;

fn u32_column(column: &Fields<'_>, key: &str, label: &str) -> Result<Vec<u32>> {
    let name = format!("{label}.{key}");
    u32_list(column.bytes_as(key, &name, 4)?, &name)
}

fn f64_column(column: &Fields<'_>, key: &str, label: &str) -> Result<Vec<f64>> {
    let name = format!("{label}.{key}");
    f64_list(column.bytes_as(key, &name, 8)?, &name)
}

fn ordinal_column(
    column: &Fields<'_>,
    key: &str,
    label: &str,
    document_count: u32,
) -> Result<Vec<u32>> {
    let values = u32_column(column, key, label)?;
    require_ordinals(column, &values, document_count, &format!("{label}.{key}"))?;
    Ok(values)
}

fn each_column<'a, T>(
    segment: &Fields<'a>,
    key: &str,
    mut decode: impl FnMut(Fields<'a>, String) -> Result<T>,
) -> Result<Vec<T>> {
    let Some(Value::Array(items)) = segment.raw(key) else {
        return Err(segment.error(format!("{key} must be a list")));
    };
    let mut out = Vec::with_capacity(items.len());
    for (at, item) in items.iter().enumerate() {
        let label = format!("{key}[{at}]");
        out.push(decode(segment.nested(item, &label)?, label)?);
    }
    Ok(out)
}

pub(crate) fn decode_field_lengths(
    segment: &Fields<'_>,
    document_count: u32,
) -> Result<Vec<FieldLengthColumn>> {
    each_column(segment, "fieldLengths", |column, label| {
        let field = column
            .string_as("field", &format!("{label}.field"))?
            .to_string();
        let lengths = u32_column(&column, "lengths", &label)?;
        column.require_count(
            lengths.len(),
            document_count as usize,
            &format!("{label}.lengths"),
        )?;
        Ok(FieldLengthColumn { field, lengths })
    })
}

pub(crate) fn decode_value_columns(
    segment: &Fields<'_>,
    key: &str,
    document_count: u32,
) -> Result<Vec<ValueColumn>> {
    each_column(segment, key, |column, label| {
        let field = column
            .string_as("field", &format!("{label}.field"))?
            .to_string();
        let documents = ordinal_column(&column, "documents", &label, document_count)?;
        let values = f64_column(&column, "values", &label)?;
        let name = format!("{label}.values");
        column.require_count(values.len(), documents.len(), &name)?;
        require_values_ascend_without_nan(&column, &values, &name)?;
        Ok(ValueColumn {
            field,
            documents,
            values,
        })
    })
}

pub(crate) fn decode_boolean_columns(
    segment: &Fields<'_>,
    document_count: u32,
) -> Result<Vec<BooleanColumn>> {
    each_column(segment, "boolean", |column, label| {
        Ok(BooleanColumn {
            field: column
                .string_as("field", &format!("{label}.field"))?
                .to_string(),
            true_documents: ordinal_column(&column, "trueDocuments", &label, document_count)?,
            false_documents: ordinal_column(&column, "falseDocuments", &label, document_count)?,
        })
    })
}

pub(crate) fn decode_enum_columns(
    segment: &Fields<'_>,
    document_count: u32,
) -> Result<Vec<EnumColumn>> {
    each_column(segment, "enum", |column, label| {
        let field = column
            .string_as("field", &format!("{label}.field"))?
            .to_string();
        let values = column.strings_as("values", &format!("{label}.values"))?;
        let distinct: HashSet<&str> = values.iter().map(String::as_str).collect();
        if distinct.len() != values.len() {
            return Err(column.error(format!("{label}.values names a value twice")));
        }
        let offsets = u32_column(&column, "offsets", &label)?;
        let documents = ordinal_column(&column, "documents", &label, document_count)?;
        let name = format!("{label}.offsets");
        column.require_count(offsets.len(), values.len() + 1, &name)?;
        require_offsets(&column, &offsets, documents.len(), &name)?;
        Ok(EnumColumn {
            field,
            values,
            offsets,
            documents,
        })
    })
}

pub(crate) fn decode_geopoint_columns(
    segment: &Fields<'_>,
    document_count: u32,
) -> Result<Vec<GeopointColumn>> {
    each_column(segment, "geopoint", |column, label| {
        let field = column
            .string_as("field", &format!("{label}.field"))?
            .to_string();
        let documents = ordinal_column(&column, "documents", &label, document_count)?;
        let latitudes = f64_column(&column, "latitudes", &label)?;
        let longitudes = f64_column(&column, "longitudes", &label)?;
        let latitude_name = format!("{label}.latitudes");
        let longitude_name = format!("{label}.longitudes");
        column.require_count(latitudes.len(), documents.len(), &latitude_name)?;
        column.require_count(longitudes.len(), documents.len(), &longitude_name)?;
        require_within(&column, &latitudes, LATITUDE_LIMIT, &latitude_name)?;
        require_within(&column, &longitudes, LONGITUDE_LIMIT, &longitude_name)?;
        Ok(GeopointColumn {
            field,
            documents,
            latitudes,
            longitudes,
        })
    })
}

fn runs_column(column: &Fields<'_>, key: &str, label: &str) -> Result<Vec<u32>> {
    let name = format!("{label}.{key}");
    let runs = u32_list(column.bytes_as(key, &name, 4 * CODE_POINTS_PER_RUN)?, &name)?;
    require_runs_ascend(column, &runs, &name)?;
    Ok(runs)
}

pub(crate) fn decode_pattern_columns(
    segment: &Fields<'_>,
    document_count: u32,
) -> Result<Vec<PatternColumn>> {
    each_column(segment, "pattern", |column, label| {
        let field = column
            .string_as("field", &format!("{label}.field"))?
            .to_string();
        let documents = ordinal_column(&column, "documents", &label, document_count)?;
        require_strictly_ascending(&column, &documents, &format!("{label}.documents"))?;
        let runs = runs_column(&column, "runs", &label)?;
        let offsets = u32_column(&column, "offsets", &label)?;
        let postings = ordinal_column(&column, "postings", &label, document_count)?;
        let offsets_name = format!("{label}.offsets");
        column.require_count(
            offsets.len(),
            runs.len() / CODE_POINTS_PER_RUN + 1,
            &offsets_name,
        )?;
        require_offsets(&column, &offsets, postings.len(), &offsets_name)?;
        let postings_name = format!("{label}.postings");
        for pair in offsets.windows(2) {
            require_strictly_ascending_within(
                &column,
                &postings,
                pair[0] as usize,
                pair[1] as usize,
                &postings_name,
            )?;
        }
        Ok(PatternColumn {
            field,
            documents,
            runs,
            offsets,
            postings,
        })
    })
}

pub(crate) fn decode_surface_forms(segment: &Fields<'_>) -> Result<Option<SurfaceForms>> {
    let Some(raw) = segment.raw("surfaceForms").filter(|raw| !raw.is_null()) else {
        return Ok(None);
    };
    let column = segment.nested(raw, "surfaceForms")?;
    let text = column.bytes_as("text", "surfaceForms.text", 1)?.to_vec();
    let offsets = u32_column(&column, "offsets", "surfaceForms")?;
    let counts = u32_column(&column, "counts", "surfaceForms")?;
    column.require_count(offsets.len(), counts.len() * 2 + 1, "surfaceForms.offsets")?;
    require_offsets(&column, &offsets, text.len(), "surfaceForms.offsets")?;
    require_utf8_entries(&column, &text, &offsets, "surfaceForms.text")?;
    Ok((!counts.is_empty()).then_some(SurfaceForms {
        text,
        offsets,
        counts,
    }))
}

pub(crate) fn decode_partial_words(
    segment: &Fields<'_>,
    token_count: usize,
) -> Result<Option<PartialWords>> {
    let Some(raw) = segment.raw("partialWords").filter(|raw| !raw.is_null()) else {
        return Ok(None);
    };
    let column = segment.nested(raw, "partialWords")?;
    let fields = column.strings_as("fields", "partialWords.fields")?;
    let text = column.bytes_as("text", "partialWords.text", 1)?.to_vec();
    let offsets = u32_column(&column, "offsets", "partialWords")?;
    let tokens = u32_column(&column, "tokens", "partialWords")?;
    let counts = u32_column(&column, "counts", "partialWords")?;
    let entries = tokens.len();
    column.require_count(offsets.len(), entries + 1, "partialWords.offsets")?;
    column.require_count(counts.len(), entries, "partialWords.counts")?;
    require_offsets(&column, &offsets, text.len(), "partialWords.offsets")?;
    require_utf8_entries(&column, &text, &offsets, "partialWords.text")?;
    require_below(&column, &tokens, token_count, "partialWords.tokens")?;
    require_non_zero(&column, &counts, "partialWords.counts")?;
    require_spelling_entries_ascend(&column, &text, &offsets, &tokens, "partialWords")?;
    let runs = runs_column(&column, "runs", "partialWords")?;
    let run_offsets = u32_column(&column, "runOffsets", "partialWords")?;
    let run_entries = u32_column(&column, "runEntries", "partialWords")?;
    column.require_count(
        run_offsets.len(),
        runs.len() / CODE_POINTS_PER_RUN + 1,
        "partialWords.runOffsets",
    )?;
    require_offsets(
        &column,
        &run_offsets,
        run_entries.len(),
        "partialWords.runOffsets",
    )?;
    require_below(&column, &run_entries, entries, "partialWords.runEntries")?;
    for pair in run_offsets.windows(2) {
        require_strictly_ascending_within(
            &column,
            &run_entries,
            pair[0] as usize,
            pair[1] as usize,
            "partialWords.runEntries",
        )?;
    }
    Ok(Some(PartialWords {
        fields,
        text,
        offsets,
        tokens,
        counts,
        runs,
        run_offsets,
        run_entries,
    }))
}
