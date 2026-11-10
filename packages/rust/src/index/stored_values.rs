use std::borrow::Cow;
use std::sync::{Arc, RwLock};

use super::constants::MAX_CACHED_FIELD_COLUMNS;
use super::derived::DerivedColumns;
use super::frozen::FrozenSegment;
use crate::error::Result;
use crate::value::{Map, Value};

const LENGTH_PROPERTY: &str = "length";

pub(crate) type FieldColumn = Arc<[Option<Value>]>;

#[derive(Default)]
pub(crate) struct StoredValues {
    columns: RwLock<Vec<(String, FieldColumn)>>,
    pub(crate) derived: DerivedColumns,
}

impl StoredValues {
    fn cached(&self, path: &str) -> Option<FieldColumn> {
        let columns = self.columns.read().ok()?;
        columns
            .iter()
            .find(|(held, _)| held == path)
            .map(|(_, column)| column.clone())
    }

    fn column(
        &self,
        path: &str,
        build: impl FnOnce() -> Result<Vec<Option<Value>>>,
    ) -> Result<FieldColumn> {
        if let Some(column) = self.cached(path) {
            return Ok(column);
        }
        let built: FieldColumn = build()?.into();
        let Ok(mut columns) = self.columns.write() else {
            return Ok(built);
        };
        if let Some((_, column)) = columns.iter().find(|(held, _)| held == path) {
            return Ok(column.clone());
        }
        if columns.len() < MAX_CACHED_FIELD_COLUMNS {
            columns.push((path.to_string(), built.clone()));
        }
        Ok(built)
    }
}

fn array_index(segment: &str) -> Option<usize> {
    let index: u32 = segment.parse().ok()?;
    (index != u32::MAX && index.to_string() == segment).then_some(index as usize)
}

fn step<'a>(current: &'a Value, segment: &str, last: bool) -> Option<Cow<'a, Value>> {
    match current {
        Value::Object(map) => map.get(segment).map(Cow::Borrowed),
        Value::Array(items) if segment == LENGTH_PROPERTY => {
            last.then_some(Cow::Owned(Value::Number(items.len() as f64)))
        }
        Value::Array(items) => items.get(array_index(segment)?).map(Cow::Borrowed),
        Value::Bytes(bytes) => {
            let byte = bytes.get(array_index(segment)?)?;
            last.then_some(Cow::Owned(Value::Number(f64::from(*byte))))
        }
        _ => None,
    }
}

pub(crate) fn path_value<'a>(document: &'a Map, path: &str) -> Option<Cow<'a, Value>> {
    let mut parts = path.split('.');
    let first = parts.next()?;
    let mut current = Cow::Borrowed(document.get(first)?);
    let mut rest = parts.peekable();
    while let Some(segment) = rest.next() {
        let last = rest.peek().is_none();
        current = match current {
            Cow::Borrowed(value) => step(value, segment, last)?,
            Cow::Owned(_) => return None,
        };
    }
    Some(current)
}

impl FrozenSegment {
    pub(crate) fn field_column(&self, path: &str) -> Result<FieldColumn> {
        self.stored_values.column(path, || {
            let mut values = Vec::with_capacity(self.capacity() as usize);
            for ordinal in 0..self.capacity() {
                let document = self.document(ordinal)?;
                values.push(path_value(&document, path).map(Cow::into_owned));
            }
            Ok(values)
        })
    }
}
