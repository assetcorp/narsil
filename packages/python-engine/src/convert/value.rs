use narsil::{ErrorCode, Map, NarsilError, Timestamp, Value};
use pyo3::prelude::*;
use pyo3::types::{
    PyBool, PyByteArray, PyBytes, PyDateTime, PyDict, PyFloat, PyInt, PyList, PyMapping,
    PySequence, PyString, PyTuple,
};

use crate::constants::{
    MAX_SAFE_INTEGER, MAX_VALUE_DEPTH, NANOSECONDS_PER_MICROSECOND, SECONDS_PER_DAY,
};
use crate::errors::to_py_err;

#[derive(Clone, Copy)]
pub(crate) struct ValueSource<'a> {
    pub(crate) code: ErrorCode,
    pub(crate) subject: &'a str,
}

struct Refusal {
    path: Vec<String>,
    reason: String,
}

impl Refusal {
    fn new(reason: String) -> Refusal {
        Refusal {
            path: Vec::new(),
            reason,
        }
    }

    fn within(mut self, segment: String) -> Refusal {
        self.path.push(segment);
        self
    }

    fn into_error(self, source: ValueSource<'_>) -> NarsilError {
        let location = if self.path.is_empty() {
            String::new()
        } else {
            let mut segments = self.path;
            segments.reverse();
            format!(" at {}", segments.join(""))
        };
        NarsilError::new(
            source.code,
            format!("{} holds {}{location}", source.subject, self.reason),
        )
    }
}

fn type_name(value: &Bound<'_, PyAny>) -> String {
    value
        .get_type()
        .name()
        .map(|name| name.to_string())
        .unwrap_or_else(|_| "object".to_string())
}

fn number_of_int(value: &Bound<'_, PyAny>) -> Result<f64, Refusal> {
    let whole: i128 = value
        .extract()
        .map_err(|_| Refusal::new("an integer outside the range of a 64-bit number".to_string()))?;
    if whole.unsigned_abs() > MAX_SAFE_INTEGER as u128 {
        return Err(Refusal::new(format!(
            "the integer {whole}, which is larger in size than {MAX_SAFE_INTEGER}, the largest integer that every Narsil implementation stores exactly"
        )));
    }
    Ok(whole as f64)
}

fn timestamp_of(value: &Bound<'_, PyAny>) -> Result<Timestamp, Refusal> {
    let py = value.py();
    let offset = value
        .call_method0("utcoffset")
        .map_err(|error| Refusal::new(format!("a datetime that has no usable offset ({error})")))?;
    if offset.is_none() {
        return Err(Refusal::new(
            "a datetime without a time zone, which Narsil cannot place in time".to_string(),
        ));
    }
    let datetime = py
        .import("datetime")
        .map_err(|error| Refusal::new(error.to_string()))?;
    let epoch = datetime
        .getattr("datetime")
        .and_then(|class| {
            class.call1((
                1970,
                1,
                1,
                0,
                0,
                0,
                0,
                datetime.getattr("timezone")?.getattr("utc")?,
            ))
        })
        .map_err(|error| Refusal::new(error.to_string()))?;
    let delta = value
        .call_method1("__sub__", (epoch,))
        .map_err(|error| Refusal::new(error.to_string()))?;
    let part = |name: &str| -> Result<i64, Refusal> {
        delta
            .getattr(name)
            .and_then(|part| part.extract::<i64>())
            .map_err(|error| Refusal::new(error.to_string()))
    };
    let days = part("days")?;
    let seconds = part("seconds")?;
    let microseconds = part("microseconds")?;
    let nanoseconds = u32::try_from(microseconds * NANOSECONDS_PER_MICROSECOND)
        .map_err(|_| Refusal::new("a datetime outside the range that Narsil stores".to_string()))?;
    Ok(Timestamp {
        seconds: days * SECONDS_PER_DAY + seconds,
        nanoseconds,
    })
}

fn object_of<'py>(
    entries: impl Iterator<Item = PyResult<(Bound<'py, PyAny>, Bound<'py, PyAny>)>>,
    depth: usize,
) -> Result<Value, Refusal> {
    let mut map = Map::new();
    for entry in entries {
        let (key, item) = entry.map_err(|error| Refusal::new(error.to_string()))?;
        let Ok(key) = key.cast::<PyString>() else {
            return Err(Refusal::new(format!(
                "a key of type {}, where every key is a string",
                type_name(&key)
            )));
        };
        let key = key
            .to_str()
            .map_err(|_| Refusal::new("a key that is not valid Unicode".to_string()))?;
        let converted =
            convert(&item, depth + 1).map_err(|refusal| refusal.within(format!("[{key:?}]")))?;
        map.insert(key, converted);
    }
    Ok(Value::Object(map))
}

fn array_of<'py>(
    items: impl Iterator<Item = Bound<'py, PyAny>>,
    depth: usize,
) -> Result<Value, Refusal> {
    let mut values = Vec::new();
    for (at, item) in items.enumerate() {
        values
            .push(convert(&item, depth + 1).map_err(|refusal| refusal.within(format!("[{at}]")))?);
    }
    Ok(Value::Array(values))
}

fn convert(value: &Bound<'_, PyAny>, depth: usize) -> Result<Value, Refusal> {
    if depth > MAX_VALUE_DEPTH {
        return Err(Refusal::new(format!(
            "values nested deeper than {MAX_VALUE_DEPTH} levels"
        )));
    }
    if value.is_none() {
        return Ok(Value::Null);
    }
    if let Ok(flag) = value.cast::<PyBool>() {
        return Ok(Value::Bool(flag.is_true()));
    }
    if value.is_instance_of::<PyInt>() {
        return number_of_int(value).map(Value::Number);
    }
    if let Ok(number) = value.cast::<PyFloat>() {
        return Ok(Value::Number(number.value()));
    }
    if let Ok(text) = value.cast::<PyString>() {
        let text = text
            .to_str()
            .map_err(|_| Refusal::new("a string that is not valid Unicode".to_string()))?;
        return Ok(Value::String(text.to_string()));
    }
    if let Ok(map) = value.cast::<PyDict>() {
        let entries: Vec<(Bound<'_, PyAny>, Bound<'_, PyAny>)> = map.iter().collect();
        return object_of(entries.into_iter().map(Ok), depth);
    }
    if let Ok(list) = value.cast::<PyList>() {
        return array_of(list.iter(), depth);
    }
    if let Ok(tuple) = value.cast::<PyTuple>() {
        return array_of(tuple.iter(), depth);
    }
    if let Ok(bytes) = value.cast::<PyBytes>() {
        return Ok(Value::Bytes(bytes.as_bytes().to_vec()));
    }
    if let Ok(bytes) = value.cast::<PyByteArray>() {
        return Ok(Value::Bytes(bytes.to_vec()));
    }
    if value.is_instance_of::<PyDateTime>() {
        return timestamp_of(value).map(Value::Timestamp);
    }
    if value.hasattr("tolist").unwrap_or(false) {
        let listed = value.call_method0("tolist").map_err(|error| {
            Refusal::new(format!(
                "a {} whose tolist() failed ({error})",
                type_name(value)
            ))
        })?;
        return convert(&listed, depth + 1);
    }
    if let Ok(mapping) = value.cast::<PyMapping>() {
        let items = mapping
            .items()
            .map_err(|error| Refusal::new(error.to_string()))?;
        let pairs: Vec<PyResult<(Bound<'_, PyAny>, Bound<'_, PyAny>)>> =
            items.iter().map(|pair| pair.extract()).collect();
        return object_of(pairs.into_iter(), depth);
    }
    if let Ok(sequence) = value.cast::<PySequence>() {
        let list = sequence
            .to_list()
            .map_err(|error| Refusal::new(error.to_string()))?;
        return array_of(list.iter(), depth);
    }
    Err(Refusal::new(format!(
        "a value of type {}, which no Narsil value can hold",
        type_name(value)
    )))
}

pub(crate) fn to_value(
    value: &Bound<'_, PyAny>,
    source: ValueSource<'_>,
) -> Result<Value, NarsilError> {
    convert(value, 0).map_err(|refusal| refusal.into_error(source))
}

pub(crate) fn to_map(
    value: &Bound<'_, PyAny>,
    source: ValueSource<'_>,
) -> Result<Map, NarsilError> {
    match to_value(value, source)? {
        Value::Object(map)
            if value.cast::<PyDict>().is_ok() || value.cast::<PyMapping>().is_ok() =>
        {
            Ok(map)
        }
        _ => Err(NarsilError::new(
            source.code,
            format!(
                "{} must be a dict with string keys, and it is a {}",
                source.subject,
                type_name(value)
            ),
        )),
    }
}

fn timestamp_to_py<'py>(py: Python<'py>, timestamp: Timestamp) -> PyResult<Bound<'py, PyAny>> {
    datetime_of(py, timestamp).map_err(|error| {
        to_py_err(NarsilError::new(
            ErrorCode::INTERNAL_ERROR,
            format!(
                "The index holds a timestamp {} seconds from 1970, which a Python datetime cannot hold ({error})",
                timestamp.seconds
            ),
        ))
    })
}

fn datetime_of<'py>(py: Python<'py>, timestamp: Timestamp) -> PyResult<Bound<'py, PyAny>> {
    let datetime = py.import("datetime")?;
    let utc = datetime.getattr("timezone")?.getattr("utc")?;
    let epoch = datetime
        .getattr("datetime")?
        .call1((1970, 1, 1, 0, 0, 0, 0, utc))?;
    let delta = datetime.getattr("timedelta")?.call1((
        0,
        timestamp.seconds,
        i64::from(timestamp.nanoseconds) / NANOSECONDS_PER_MICROSECOND,
    ))?;
    epoch.call_method1("__add__", (delta,))
}

fn number_to_py(py: Python<'_>, number: f64) -> PyResult<Bound<'_, PyAny>> {
    if number.is_finite() && number.fract() == 0.0 && number.abs() <= MAX_SAFE_INTEGER as f64 {
        return Ok((number as i64).into_pyobject(py)?.into_any());
    }
    Ok(PyFloat::new(py, number).into_any())
}

pub(crate) fn value_to_py<'py>(py: Python<'py>, value: &Value) -> PyResult<Bound<'py, PyAny>> {
    Ok(match value {
        Value::Null => py.None().into_bound(py),
        Value::Bool(flag) => PyBool::new(py, *flag).to_owned().into_any(),
        Value::Number(number) => number_to_py(py, *number)?,
        Value::String(text) => PyString::new(py, text).into_any(),
        Value::Bytes(bytes) => PyBytes::new(py, bytes).into_any(),
        Value::Timestamp(timestamp) => timestamp_to_py(py, *timestamp)?,
        Value::Array(items) => {
            let list = PyList::empty(py);
            for item in items {
                list.append(value_to_py(py, item)?)?;
            }
            list.into_any()
        }
        Value::Object(map) => map_to_py(py, map)?.into_any(),
    })
}

pub(crate) fn map_to_py<'py>(py: Python<'py>, map: &Map) -> PyResult<Bound<'py, PyDict>> {
    let dict = PyDict::new(py);
    for (key, item) in map.iter() {
        dict.set_item(key, value_to_py(py, item)?)?;
    }
    Ok(dict)
}
