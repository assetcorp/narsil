use std::sync::Arc;

use super::derived::DerivedColumn;
use super::segment::SegmentEntry;
use crate::engine::query::documents::FieldReader;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::ffi;
use crate::value::{Value, encode_value, number_to_text};

const SHAPE_ABSENT: u8 = 0;
const SHAPE_ONE_VALUE: u8 = 1;
const SHAPE_ARRAY: u8 = 2;
const KIND_NULL: u8 = 0;
const KIND_FALSE: u8 = 1;
const KIND_TRUE: u8 = 2;
const KIND_NUMBER: u8 = 3;
const KIND_STRING: u8 = 4;
const KIND_OTHER: u8 = 5;
const MAX_STORED_TEXT_UNITS: usize = 0x4000_0000;

#[derive(Clone)]
pub(crate) struct CoreStoredValues {
    shapes: Vec<u8>,
    starts: Vec<u32>,
    kinds: Vec<u8>,
    numbers: Vec<f64>,
    text_start: Vec<u32>,
    text_length: Vec<u32>,
    units: Vec<u16>,
    bytes: Vec<u8>,
}

impl Default for CoreStoredValues {
    fn default() -> CoreStoredValues {
        CoreStoredValues {
            shapes: Vec::new(),
            starts: vec![0],
            kinds: Vec::new(),
            numbers: Vec::new(),
            text_start: Vec::new(),
            text_length: Vec::new(),
            units: Vec::new(),
            bytes: Vec::new(),
        }
    }
}

impl DerivedColumn for CoreStoredValues {
    fn len(&self) -> usize {
        self.shapes.len()
    }
}

fn layout_exceeded() -> NarsilError {
    NarsilError::new(
        ErrorCode::CONFIG_INVALID,
        "The stored field exceeds the native value layout",
    )
}

fn checked(count: usize) -> Result<u32> {
    u32::try_from(count).map_err(|_| layout_exceeded())
}

impl CoreStoredValues {
    fn push_element(&mut self, value: &Value) -> Result<()> {
        let (kind, number, start, length) = match value {
            Value::Null => (KIND_NULL, 0.0, 0, 0),
            Value::Bool(false) => (KIND_FALSE, 0.0, 0, 0),
            Value::Bool(true) => (KIND_TRUE, 0.0, 0, 0),
            Value::Number(number) => (KIND_NUMBER, *number, 0, 0),
            Value::String(text) => {
                let start = self.units.len();
                self.units.extend(text.encode_utf16());
                let length = self.units.len() - start;
                if length > MAX_STORED_TEXT_UNITS {
                    self.units.truncate(start);
                    return Err(NarsilError::new(
                        ErrorCode::CONFIG_INVALID,
                        "The stored string exceeds the native text layout",
                    ));
                }
                checked(self.units.len())?;
                (KIND_STRING, 0.0, start, length)
            }
            other => {
                let encoded = encode_value(other)?;
                let start = self.bytes.len();
                self.bytes.extend_from_slice(&encoded);
                checked(self.bytes.len())?;
                (KIND_OTHER, 0.0, start, encoded.len())
            }
        };
        self.kinds.push(kind);
        self.numbers.push(number);
        self.text_start.push(checked(start)?);
        self.text_length.push(checked(length)?);
        Ok(())
    }

    pub(crate) fn push(&mut self, value: Option<&Value>) -> Result<()> {
        checked(self.shapes.len() + 1)?;
        let shape = match value {
            None => SHAPE_ABSENT,
            Some(Value::Array(items)) => {
                checked(self.kinds.len() + items.len())?;
                for item in items {
                    self.push_element(item)?;
                }
                SHAPE_ARRAY
            }
            Some(value) => {
                self.push_element(value)?;
                SHAPE_ONE_VALUE
            }
        };
        self.shapes.push(shape);
        self.starts.push(checked(self.kinds.len())?);
        Ok(())
    }

    pub(crate) fn view(&self) -> ffi::narsil_stored_values {
        ffi::narsil_stored_values {
            shapes: self.shapes.as_ptr(),
            shape_count: self.shapes.len(),
            starts: self.starts.as_ptr(),
            start_count: self.starts.len(),
            kinds: self.kinds.as_ptr(),
            kind_count: self.kinds.len(),
            numbers: self.numbers.as_ptr(),
            number_count: self.numbers.len(),
            text_start: self.text_start.as_ptr(),
            text_start_count: self.text_start.len(),
            text_length: self.text_length.as_ptr(),
            text_length_count: self.text_length.len(),
            units: self.units.as_ptr(),
            unit_count: self.units.len(),
            bytes: self.bytes.as_ptr(),
            byte_count: self.bytes.len(),
        }
    }

    pub(crate) fn units(&self, start: u32, length: u32) -> &[u16] {
        let start = start as usize;
        self.units
            .get(start..start + length as usize)
            .unwrap_or(&[])
    }

    pub(crate) fn element_count(&self) -> usize {
        self.kinds.len()
    }

    pub(crate) fn bucket_key(&self, element: usize) -> Option<String> {
        match *self.kinds.get(element)? {
            KIND_FALSE => Some("false".to_string()),
            KIND_TRUE => Some("true".to_string()),
            KIND_NUMBER => Some(number_to_text(self.numbers[element])),
            KIND_STRING => {
                let start = self.text_start[element] as usize;
                let end = start + self.text_length[element] as usize;
                Some(String::from_utf16_lossy(self.units.get(start..end)?))
            }
            _ => None,
        }
    }
}

impl SegmentEntry {
    pub(crate) fn core_stored_values(&self, path: &str) -> Result<Arc<CoreStoredValues>> {
        self.derived().stored_values.column(
            |held| held == path,
            || path.to_string(),
            self.capacity() as usize,
            |column, range| {
                let reader = FieldReader::of(self, path)?;
                for ordinal in range {
                    column.push(reader.get(ordinal as u32).as_deref())?;
                }
                Ok(())
            },
        )
    }
}
