use crate::error::{NarsilError, Result};
use crate::format::fields::Fields;
use crate::value::{Value, number_to_text};

fn named(fields: &Fields<'_>, message: String, name: &str) -> NarsilError {
    fields.field_error(message, [("field", Value::from(name))])
}

fn named_at(fields: &Fields<'_>, message: String, name: &str, at: usize) -> NarsilError {
    fields.field_error(
        message,
        [("field", Value::from(name)), ("at", Value::from(at))],
    )
}

pub(crate) fn require_offsets(
    fields: &Fields<'_>,
    offsets: &[u32],
    list_size: usize,
    name: &str,
) -> Result<()> {
    let Some((&first, _)) = offsets.split_first() else {
        return Err(named(
            fields,
            format!("{name} must hold at least one value"),
            name,
        ));
    };
    if first != 0 {
        return Err(named(fields, format!("{name} must start at 0"), name));
    }
    if let Some(at) = offsets.windows(2).position(|pair| pair[1] < pair[0]) {
        return Err(named_at(
            fields,
            format!("{name} decreases at entry {}", at + 1),
            name,
            at + 1,
        ));
    }
    let last = offsets[offsets.len() - 1];
    if last as usize != list_size {
        return Err(named(
            fields,
            format!("{name} ends at {last} where the list it divides holds {list_size}"),
            name,
        ));
    }
    Ok(())
}

pub(crate) fn require_utf8_entries(
    fields: &Fields<'_>,
    blob: &[u8],
    offsets: &[u32],
    name: &str,
) -> Result<()> {
    if std::str::from_utf8(blob).is_err() {
        return Err(named(fields, format!("{name} is not valid UTF-8"), name));
    }
    for (at, offset) in offsets.iter().enumerate() {
        let offset = *offset as usize;
        if offset < blob.len() && (blob[offset] & 0xc0) == 0x80 {
            return Err(named_at(
                fields,
                format!("{name} splits a character at entry {at}"),
                name,
                at,
            ));
        }
    }
    Ok(())
}

pub(crate) fn require_ordinals(
    fields: &Fields<'_>,
    values: &[u32],
    document_count: u32,
    name: &str,
) -> Result<()> {
    if let Some(at) = values.iter().position(|value| *value >= document_count) {
        return Err(named_at(
            fields,
            format!(
                "{name} names document {} of a segment of {document_count}",
                values[at]
            ),
            name,
            at,
        ));
    }
    Ok(())
}

pub(crate) fn require_strictly_ascending(
    fields: &Fields<'_>,
    values: &[u32],
    name: &str,
) -> Result<()> {
    require_strictly_ascending_within(fields, values, 0, values.len(), name)
}

pub(crate) fn require_strictly_ascending_within(
    fields: &Fields<'_>,
    values: &[u32],
    start: usize,
    end: usize,
    name: &str,
) -> Result<()> {
    for at in start + 1..end {
        if values[at] <= values[at - 1] {
            return Err(named_at(
                fields,
                format!("{name} fails to ascend strictly at entry {at}"),
                name,
                at,
            ));
        }
    }
    Ok(())
}

fn entry<'b>(blob: &'b [u8], offsets: &[u32], index: usize) -> &'b [u8] {
    &blob[offsets[index] as usize..offsets[index + 1] as usize]
}

pub(crate) fn require_entries_ascend(
    fields: &Fields<'_>,
    blob: &[u8],
    offsets: &[u32],
    order: Option<&[u32]>,
    name: &str,
) -> Result<()> {
    let count = offsets.len().saturating_sub(1);
    for at in 1..count {
        let (left, right) = match order {
            Some(order) => (order[at - 1] as usize, order[at] as usize),
            None => (at - 1, at),
        };
        if entry(blob, offsets, left) >= entry(blob, offsets, right) {
            return Err(named_at(
                fields,
                format!("{name} fails to ascend strictly at entry {at}"),
                name,
                at,
            ));
        }
    }
    Ok(())
}

pub(crate) fn require_spelling_entries_ascend(
    fields: &Fields<'_>,
    blob: &[u8],
    offsets: &[u32],
    tokens: &[u32],
    name: &str,
) -> Result<()> {
    for at in 1..tokens.len() {
        let order = entry(blob, offsets, at - 1)
            .cmp(entry(blob, offsets, at))
            .then(tokens[at - 1].cmp(&tokens[at]));
        if order != std::cmp::Ordering::Less {
            return Err(named_at(
                fields,
                format!("{name} fails to ascend strictly at entry {at}"),
                name,
                at,
            ));
        }
    }
    Ok(())
}

pub(crate) fn require_below(
    fields: &Fields<'_>,
    values: &[u32],
    limit: usize,
    name: &str,
) -> Result<()> {
    if let Some(at) = values.iter().position(|value| *value as usize >= limit) {
        return Err(named_at(
            fields,
            format!(
                "{name} holds {} at entry {at}, at or above {limit}",
                values[at]
            ),
            name,
            at,
        ));
    }
    Ok(())
}

pub(crate) fn require_non_zero(fields: &Fields<'_>, values: &[u32], name: &str) -> Result<()> {
    if let Some(at) = values.iter().position(|value| *value == 0) {
        return Err(named_at(
            fields,
            format!("{name} holds 0 at entry {at}"),
            name,
            at,
        ));
    }
    Ok(())
}

pub(crate) fn require_permutation(fields: &Fields<'_>, order: &[u32], name: &str) -> Result<()> {
    let mut seen = vec![false; order.len()];
    for (at, ordinal) in order.iter().enumerate() {
        let index = *ordinal as usize;
        if index >= order.len() || seen[index] {
            return Err(named_at(
                fields,
                format!("{name} repeats or overruns ordinal {ordinal}"),
                name,
                at,
            ));
        }
        seen[index] = true;
    }
    Ok(())
}

pub(crate) fn require_values_ascend_without_nan(
    fields: &Fields<'_>,
    values: &[f64],
    name: &str,
) -> Result<()> {
    for (at, value) in values.iter().enumerate() {
        if value.is_nan() {
            return Err(named_at(
                fields,
                format!("{name} holds NaN at entry {at}"),
                name,
                at,
            ));
        }
        if at > 0 && *value < values[at - 1] {
            return Err(named_at(
                fields,
                format!("{name} descends at entry {at}"),
                name,
                at,
            ));
        }
    }
    Ok(())
}

pub(crate) fn require_within(
    fields: &Fields<'_>,
    values: &[f64],
    limit: f64,
    name: &str,
) -> Result<()> {
    if let Some(at) = values
        .iter()
        .position(|value| !(*value >= -limit && *value <= limit))
    {
        return Err(named_at(
            fields,
            format!(
                "{name} holds {} at entry {at}, outside {} to {}",
                number_to_text(values[at]),
                number_to_text(-limit),
                number_to_text(limit)
            ),
            name,
            at,
        ));
    }
    Ok(())
}

pub(crate) fn require_runs_ascend(fields: &Fields<'_>, runs: &[u32], name: &str) -> Result<()> {
    for run in 1..runs.len() / 3 {
        let at = run * 3;
        if runs[at..at + 3] <= runs[at - 3..at] {
            return Err(fields.field_error(
                format!("{name} fails to ascend strictly at run {run}"),
                [("field", Value::from(name)), ("run", Value::from(run))],
            ));
        }
    }
    Ok(())
}
