use super::constants::SORT_VALUE_MAX_CODE_POINTS;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::ffi;
use crate::value::Value;

const KIND_MISSING: u8 = ffi::NARSIL_SORT_MISSING as u8;
const KIND_NUMBER: u8 = ffi::NARSIL_SORT_NUMBER as u8;
const KIND_STRING: u8 = ffi::NARSIL_SORT_STRING as u8;
const KIND_FALSE: u8 = ffi::NARSIL_SORT_FALSE as u8;
const KIND_TRUE: u8 = ffi::NARSIL_SORT_TRUE as u8;

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum OwnedSortValue {
    Missing,
    Number(f64),
    Text(String),
    Bool(bool),
}

impl OwnedSortValue {
    pub(crate) fn of_cursor(value: &Value) -> OwnedSortValue {
        match value {
            Value::Number(number) if number.is_finite() => OwnedSortValue::Number(*number),
            Value::String(text) => OwnedSortValue::Text(truncate_sort_text(text).to_string()),
            Value::Bool(flag) => OwnedSortValue::Bool(*flag),
            _ => OwnedSortValue::Missing,
        }
    }

    pub(crate) fn cursor_value(self) -> Value {
        match self {
            OwnedSortValue::Missing => Value::Null,
            OwnedSortValue::Number(number) => Value::Number(number),
            OwnedSortValue::Text(text) => Value::String(text),
            OwnedSortValue::Bool(flag) => Value::Bool(flag),
        }
    }
}

pub(crate) fn truncate_sort_text(text: &str) -> &str {
    match text.char_indices().nth(SORT_VALUE_MAX_CODE_POINTS) {
        Some((end, _)) => &text[..end],
        None => text,
    }
}

fn layout_exceeded() -> NarsilError {
    NarsilError::new(
        ErrorCode::CONFIG_INVALID,
        "The sort strings exceed the native value layout",
    )
}

#[derive(Clone, Default)]
pub(crate) struct SortValues {
    kinds: Vec<u8>,
    numbers: Vec<f64>,
    text_start: Vec<u32>,
    text_length: Vec<u32>,
    units: Vec<u16>,
}

impl SortValues {
    pub(crate) fn len(&self) -> usize {
        self.kinds.len()
    }

    fn push_entry(&mut self, kind: u8, number: f64, units: &[u16]) -> Result<()> {
        let start = u32::try_from(self.units.len()).map_err(|_| layout_exceeded())?;
        let length = u32::try_from(units.len()).map_err(|_| layout_exceeded())?;
        u32::try_from(self.units.len() + units.len()).map_err(|_| layout_exceeded())?;
        self.units.extend_from_slice(units);
        self.kinds.push(kind);
        self.numbers.push(number);
        self.text_start
            .push(if kind == KIND_STRING { start } else { 0 });
        self.text_length.push(length);
        Ok(())
    }

    pub(crate) fn push_missing(&mut self) -> Result<()> {
        self.push_entry(KIND_MISSING, 0.0, &[])
    }

    pub(crate) fn push_number(&mut self, number: f64) -> Result<()> {
        match number.is_finite() {
            true => self.push_entry(KIND_NUMBER, number, &[]),
            false => self.push_missing(),
        }
    }

    pub(crate) fn push_units(&mut self, units: &[u16]) -> Result<()> {
        self.push_entry(KIND_STRING, 0.0, units)
    }

    pub(crate) fn push_bool(&mut self, flag: bool) -> Result<()> {
        self.push_entry(if flag { KIND_TRUE } else { KIND_FALSE }, 0.0, &[])
    }

    pub(crate) fn push(&mut self, value: &OwnedSortValue) -> Result<()> {
        match value {
            OwnedSortValue::Missing => self.push_missing(),
            OwnedSortValue::Number(number) => self.push_number(*number),
            OwnedSortValue::Text(text) => {
                let units: Vec<u16> = truncate_sort_text(text).encode_utf16().collect();
                self.push_units(&units)
            }
            OwnedSortValue::Bool(flag) => self.push_bool(*flag),
        }
    }

    pub(crate) fn append(&mut self, other: &SortValues) -> Result<()> {
        for at in 0..other.len() {
            self.push_entry(other.kinds[at], other.numbers[at], other.text_units(at))?;
        }
        Ok(())
    }

    fn text_units(&self, at: usize) -> &[u16] {
        if self.kinds[at] != KIND_STRING {
            return &[];
        }
        let start = self.text_start[at] as usize;
        let end = start + self.text_length[at] as usize;
        self.units.get(start..end).unwrap_or(&[])
    }

    pub(crate) fn value(&self, at: usize) -> OwnedSortValue {
        match self.kinds.get(at).copied() {
            Some(KIND_NUMBER) => OwnedSortValue::Number(self.numbers[at]),
            Some(KIND_STRING) => {
                OwnedSortValue::Text(String::from_utf16_lossy(self.text_units(at)))
            }
            Some(KIND_FALSE) => OwnedSortValue::Bool(false),
            Some(KIND_TRUE) => OwnedSortValue::Bool(true),
            _ => OwnedSortValue::Missing,
        }
    }

    pub(crate) fn is_missing(&self, at: usize) -> bool {
        self.kinds.get(at).is_none_or(|kind| *kind == KIND_MISSING)
    }

    pub(crate) fn text_unit_count(&self, at: usize) -> usize {
        self.text_units(at).len()
    }

    pub(crate) fn view(&self) -> ffi::narsil_sort_values {
        ffi::narsil_sort_values {
            kinds: self.kinds.as_ptr(),
            count: self.kinds.len(),
            numbers: self.numbers.as_ptr(),
            number_count: self.numbers.len(),
            text_start: self.text_start.as_ptr(),
            text_start_count: self.text_start.len(),
            text_length: self.text_length.as_ptr(),
            text_length_count: self.text_length.len(),
            units: self.units.as_ptr(),
            unit_count: self.units.len(),
        }
    }

    pub(crate) fn with_room(entries: usize, units: usize) -> SortValues {
        SortValues {
            kinds: vec![0; entries],
            numbers: vec![0.0; entries],
            text_start: vec![0; entries],
            text_length: vec![0; entries],
            units: vec![0; units],
        }
    }

    pub(crate) fn output(&mut self) -> ffi::narsil_sort_values_output {
        ffi::narsil_sort_values_output {
            kinds: self.kinds.as_mut_ptr(),
            capacity: self.kinds.len(),
            numbers: self.numbers.as_mut_ptr(),
            number_capacity: self.numbers.len(),
            text_start: self.text_start.as_mut_ptr(),
            text_start_capacity: self.text_start.len(),
            text_length: self.text_length.as_mut_ptr(),
            text_length_capacity: self.text_length.len(),
            units: self.units.as_mut_ptr(),
            unit_capacity: self.units.len(),
        }
    }

    pub(crate) fn truncate(&mut self, entries: usize) {
        self.kinds.truncate(entries);
        self.numbers.truncate(entries);
        self.text_start.truncate(entries);
        self.text_length.truncate(entries);
        let used = (0..entries)
            .map(|at| (self.text_start[at] + self.text_length[at]) as usize)
            .max()
            .unwrap_or(0);
        self.units.truncate(used);
    }
}
