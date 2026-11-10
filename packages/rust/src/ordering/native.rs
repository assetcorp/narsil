use super::values::SortValues;
use crate::engine::SortMode;
use crate::error::Result;
use crate::ffi;
use crate::index::core_values::CoreStoredValues;
use crate::native::status::core_refused;
use crate::native::workspace::with_workspace;

const WORD_BITS: usize = 32;
const ORDER_COUNTS: usize = 2;

pub(crate) fn bitset_words(count: usize) -> usize {
    count.div_ceil(WORD_BITS).max(1)
}

pub(crate) fn every_ordinal(count: usize) -> Vec<u32> {
    let mut words = vec![0u32; bitset_words(count)];
    for (at, word) in words.iter_mut().enumerate() {
        let start = at * WORD_BITS;
        let set = count.saturating_sub(start).min(WORD_BITS);
        *word = match set {
            WORD_BITS => u32::MAX,
            0 => 0,
            bits => (1u32 << bits) - 1,
        };
    }
    words
}

pub(crate) fn padded(words: &[u32], count: usize) -> Vec<u32> {
    let mut padded = vec![0u32; bitset_words(count)];
    for (into, word) in padded.iter_mut().zip(words) {
        *into = *word;
    }
    padded
}

fn mode_code(mode: SortMode) -> u32 {
    match mode {
        SortMode::Min => ffi::NARSIL_SORT_MIN,
        SortMode::Max => ffi::NARSIL_SORT_MAX,
        SortMode::Avg => ffi::NARSIL_SORT_AVG,
        SortMode::Median => ffi::NARSIL_SORT_MEDIAN,
    }
}

pub(crate) fn push_reduced(
    stored: &CoreStoredValues,
    ordinal: u32,
    mode: SortMode,
    into: &mut SortValues,
) -> Result<()> {
    let view = stored.view();
    let mut number = [0f64; 1];
    let mut text = [0u32; 2];
    let mut output = ffi::narsil_sort_value_output {
        number: number.as_mut_ptr(),
        number_capacity: number.len(),
        text: text.as_mut_ptr(),
        text_capacity: text.len(),
        kind: ffi::NARSIL_SORT_MISSING,
    };
    let status = with_workspace(|workspace| {
        Ok(unsafe {
            ffi::narsil_sort_value(workspace, &view, ordinal, mode_code(mode), &mut output)
        })
    })?;
    if status != ffi::NARSIL_OK {
        return Err(core_refused("a sort value", status));
    }
    match output.kind {
        ffi::NARSIL_SORT_NUMBER => into.push_number(number[0]),
        ffi::NARSIL_SORT_STRING => into.push_units(stored.units(text[0], text[1])),
        ffi::NARSIL_SORT_FALSE => into.push_bool(false),
        ffi::NARSIL_SORT_TRUE => into.push_bool(true),
        _ => into.push_missing(),
    }
}

#[derive(Clone, Default)]
pub(crate) struct SortOrder {
    pub(crate) values: SortValues,
    pub(crate) ranks: Vec<i32>,
    pub(crate) ordered: Vec<u32>,
}

pub(crate) fn build_order(current: &SortValues, live: &[u32]) -> Result<SortOrder> {
    let live = padded(live, current.len());
    let present: Vec<usize> = (0..current.len())
        .filter(|at| {
            live[at / WORD_BITS] & (1 << (at % WORD_BITS)) != 0 && !current.is_missing(*at)
        })
        .collect();
    let units: usize = present.iter().map(|at| current.text_unit_count(*at)).sum();
    let mut values = SortValues::with_room(present.len(), units);
    let mut ranks = vec![-1i32; current.len()];
    let mut ordered = vec![0u32; present.len()];
    let mut dirty = vec![0u32; bitset_words(current.len())];
    let mut counts = [0u32; ORDER_COUNTS];
    let view = current.view();
    let mut output = ffi::narsil_sort_order_output {
        values: values.output(),
        ranks: ranks.as_mut_ptr(),
        rank_capacity: ranks.len(),
        ordered: ordered.as_mut_ptr(),
        ordered_capacity: ordered.len(),
        dirty: dirty.as_mut_ptr(),
        dirty_capacity: dirty.len(),
        counts: counts.as_mut_ptr(),
        count_capacity: counts.len(),
    };
    let status = with_workspace(|workspace| {
        Ok(unsafe {
            ffi::narsil_build_sort_order(workspace, &view, live.as_ptr(), live.len(), &mut output)
        })
    })?;
    if status != ffi::NARSIL_OK {
        return Err(core_refused("a sort order", status));
    }
    values.truncate(counts[0] as usize);
    ordered.truncate(counts[1] as usize);
    Ok(SortOrder {
        values,
        ranks,
        ordered,
    })
}

pub(crate) struct SelectRequest<'a> {
    pub(crate) columns: &'a [ffi::narsil_sort_column],
    pub(crate) descending: &'a [u8],
    pub(crate) filter: &'a [u32],
    pub(crate) live: &'a [u32],
    pub(crate) limit: u32,
    pub(crate) anchor: Option<(&'a [i32], &'a SortValues)>,
}

pub(crate) fn sort_select(request: &SelectRequest<'_>) -> Result<Vec<u32>> {
    let Some(leading) = request.columns.first() else {
        return Ok(Vec::new());
    };
    let mut output = vec![0u32; leading.current.count.max(1)];
    let anchor_values = request.anchor.map(|(_, values)| values.view());
    let (anchor_ranks, anchor_rank_count) = match request.anchor {
        Some((ranks, _)) => (ranks.as_ptr(), ranks.len()),
        None => (std::ptr::null(), 0),
    };
    let call = ffi::narsil_sort_select_request {
        columns: request.columns.as_ptr(),
        column_count: request.columns.len(),
        directions: request.descending.as_ptr(),
        direction_count: request.descending.len(),
        filter: request.filter.as_ptr(),
        filter_words: request.filter.len(),
        live: request.live.as_ptr(),
        live_words: request.live.len(),
        limit: request.limit,
        anchor_ranks,
        anchor_rank_count,
        anchor_values: anchor_values.as_ref().map_or(std::ptr::null(), |values| {
            values as *const ffi::narsil_sort_values
        }),
        output: output.as_mut_ptr(),
        output_capacity: output.len(),
    };
    let mut count = 0u32;
    let status = with_workspace(|workspace| {
        Ok(unsafe { ffi::narsil_sort_select(workspace, &call, &mut count) })
    })?;
    if status != ffi::NARSIL_OK {
        return Err(core_refused("a sorted selection", status));
    }
    output.truncate(count as usize);
    Ok(output)
}

pub(crate) struct TextRangeBounds<'a> {
    pub(crate) lower: Option<&'a str>,
    pub(crate) lower_inclusive: bool,
    pub(crate) upper: Option<&'a str>,
    pub(crate) upper_inclusive: bool,
}

fn bound_of(units: &Option<Vec<u16>>, inclusive: bool) -> ffi::narsil_sort_bound {
    match units {
        Some(units) => ffi::narsil_sort_bound {
            units: units.as_ptr(),
            length: units.len(),
            present: 1,
            inclusive: u32::from(inclusive),
        },
        None => ffi::narsil_sort_bound {
            units: std::ptr::null(),
            length: 0,
            present: 0,
            inclusive: 0,
        },
    }
}

pub(crate) fn text_range(
    column: &ffi::narsil_sort_column,
    bounds: &TextRangeBounds<'_>,
    live: &[u32],
) -> Result<Vec<u32>> {
    let lower = bounds
        .lower
        .map(|text| text.encode_utf16().collect::<Vec<u16>>());
    let upper = bounds
        .upper
        .map(|text| text.encode_utf16().collect::<Vec<u16>>());
    let live = padded(live, column.current.count);
    let mut output = vec![0u32; live.len()];
    let request = ffi::narsil_text_range_request {
        lower: bound_of(&lower, bounds.lower_inclusive),
        upper: bound_of(&upper, bounds.upper_inclusive),
        live: live.as_ptr(),
        live_words: live.len(),
        output: output.as_mut_ptr(),
        output_words: output.len(),
    };
    let status = unsafe { ffi::narsil_text_range(column, &request) };
    if status != ffi::NARSIL_OK {
        return Err(core_refused("a text range", status));
    }
    Ok(output)
}
