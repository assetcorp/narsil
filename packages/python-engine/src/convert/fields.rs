use narsil::{ErrorCode, NarsilError, Value};
use pyo3::prelude::*;
use pyo3::types::{
    PyBool, PyByteArray, PyBytes, PyDict, PyFloat, PyFrozenSet, PyInt, PyList, PyMapping, PySet,
    PyString, PyTuple,
};

use super::value::{ValueSource, to_value};
use crate::constants::MAX_SAFE_INTEGER;
use crate::errors::config_invalid;

fn kind_of(value: &Bound<'_, PyAny>) -> String {
    value
        .get_type()
        .name()
        .map(|name| name.to_string())
        .unwrap_or_else(|_| "object".to_string())
}

pub(crate) struct Fields<'py> {
    dict: Bound<'py, PyDict>,
    label: String,
    known: Vec<&'static str>,
}

impl<'py> Fields<'py> {
    pub(crate) fn of(value: &Bound<'py, PyAny>, label: &str) -> Result<Fields<'py>, NarsilError> {
        let dict = if let Ok(dict) = value.cast::<PyDict>() {
            dict.clone()
        } else if let Ok(mapping) = value.cast::<PyMapping>() {
            let dict = PyDict::new(value.py());
            dict.update(mapping).map_err(|error| {
                config_invalid(format!("{label} cannot be read as a dict: {error}"))
            })?;
            dict
        } else {
            return Err(config_invalid(format!(
                "{label} must be a dict, and it is a {}",
                kind_of(value)
            )));
        };
        Ok(Fields {
            dict,
            label: label.to_string(),
            known: Vec::new(),
        })
    }

    pub(crate) fn path(&self, key: &str) -> String {
        format!("{}.{key}", self.label)
    }

    fn wrong(&self, key: &str, wanted: &str, value: &Bound<'_, PyAny>) -> NarsilError {
        config_invalid(format!(
            "{} must be {wanted}, and it is a {}",
            self.path(key),
            kind_of(value)
        ))
    }

    pub(crate) fn get(
        &mut self,
        key: &'static str,
    ) -> Result<Option<Bound<'py, PyAny>>, NarsilError> {
        self.known.push(key);
        let found = self.dict.get_item(key).map_err(|error| {
            config_invalid(format!("{} cannot be read: {error}", self.path(key)))
        })?;
        Ok(found.filter(|value| !value.is_none()))
    }

    pub(crate) fn present(
        &mut self,
        key: &'static str,
    ) -> Result<Option<Bound<'py, PyAny>>, NarsilError> {
        self.known.push(key);
        self.dict
            .get_item(key)
            .map_err(|error| config_invalid(format!("{} cannot be read: {error}", self.path(key))))
    }

    pub(crate) fn refuse_none(
        &mut self,
        key: &'static str,
        code: ErrorCode,
    ) -> Result<(), NarsilError> {
        if self.present(key)?.is_some_and(|value| value.is_none()) {
            return Err(NarsilError::new(
                code,
                format!(
                    "{} is None, so leave the key out or give it a value",
                    self.path(key)
                ),
            ));
        }
        Ok(())
    }

    pub(crate) fn refuse_each_none(
        &mut self,
        keys: &[&'static str],
        code: ErrorCode,
    ) -> Result<(), NarsilError> {
        keys.iter().try_for_each(|key| self.refuse_none(key, code))
    }

    pub(crate) fn string(&mut self, key: &'static str) -> Result<Option<String>, NarsilError> {
        let Some(value) = self.get(key)? else {
            return Ok(None);
        };
        match value.cast::<PyString>() {
            Ok(text) => text
                .to_str()
                .map(|text| Some(text.to_string()))
                .map_err(|_| config_invalid(format!("{} must be valid Unicode", self.path(key)))),
            Err(_) => Err(self.wrong(key, "a string", &value)),
        }
    }

    pub(crate) fn required_string(&mut self, key: &'static str) -> Result<String, NarsilError> {
        self.string(key)?
            .ok_or_else(|| config_invalid(format!("{} is required", self.path(key))))
    }

    pub(crate) fn boolean(&mut self, key: &'static str) -> Result<Option<bool>, NarsilError> {
        let Some(value) = self.get(key)? else {
            return Ok(None);
        };
        match value.cast::<PyBool>() {
            Ok(flag) => Ok(Some(flag.is_true())),
            Err(_) => Err(self.wrong(key, "a bool", &value)),
        }
    }

    pub(crate) fn number(&mut self, key: &'static str) -> Result<Option<f64>, NarsilError> {
        let Some(value) = self.get(key)? else {
            return Ok(None);
        };
        let path = self.path(key);
        number_of(&value, &path).map(Some)
    }

    pub(crate) fn whole(&mut self, key: &'static str) -> Result<Option<u64>, NarsilError> {
        let Some(value) = self.get(key)? else {
            return Ok(None);
        };
        let path = self.path(key);
        whole_of(&value, &path).map(Some)
    }

    pub(crate) fn whole_u32(&mut self, key: &'static str) -> Result<Option<u32>, NarsilError> {
        let path = self.path(key);
        self.whole(key)?
            .map(|whole| {
                u32::try_from(whole)
                    .map_err(|_| config_invalid(format!("{path} must be at most {}", u32::MAX)))
            })
            .transpose()
    }

    pub(crate) fn size(&mut self, key: &'static str) -> Result<Option<usize>, NarsilError> {
        let path = self.path(key);
        self.whole(key)?
            .map(|whole| {
                usize::try_from(whole).map_err(|_| config_invalid(format!("{path} is too large")))
            })
            .transpose()
    }

    pub(crate) fn strings(
        &mut self,
        key: &'static str,
    ) -> Result<Option<Vec<String>>, NarsilError> {
        let Some(value) = self.get(key)? else {
            return Ok(None);
        };
        let path = self.path(key);
        strings_of(&value, &path).map(Some)
    }

    pub(crate) fn fields(&mut self, key: &'static str) -> Result<Option<Fields<'py>>, NarsilError> {
        let Some(value) = self.get(key)? else {
            return Ok(None);
        };
        let path = self.path(key);
        Fields::of(&value, &path).map(Some)
    }

    pub(crate) fn value(&mut self, key: &'static str) -> Result<Option<Value>, NarsilError> {
        let Some(value) = self.get(key)? else {
            return Ok(None);
        };
        let path = self.path(key);
        to_value(
            &value,
            ValueSource {
                code: narsil::ErrorCode::CONFIG_INVALID,
                subject: &path,
            },
        )
        .map(Some)
    }

    pub(crate) fn choice<T: Copy>(
        &mut self,
        key: &'static str,
        choices: &[(&str, T)],
    ) -> Result<Option<T>, NarsilError> {
        let Some(name) = self.string(key)? else {
            return Ok(None);
        };
        let path = self.path(key);
        choice_of(&name, &path, choices).map(Some)
    }

    pub(crate) fn entries(&self) -> Vec<(Bound<'py, PyAny>, Bound<'py, PyAny>)> {
        self.dict.iter().collect()
    }

    pub(crate) fn finish(self) -> Result<(), NarsilError> {
        let keys: Vec<Bound<'py, PyAny>> = self.dict.iter().map(|(key, _)| key).collect();
        for key in keys {
            let named = key
                .cast::<PyString>()
                .ok()
                .and_then(|key| key.to_str().ok().map(str::to_string));
            match named {
                Some(name) if self.known.contains(&name.as_str()) => {}
                Some(name) => {
                    return Err(config_invalid(format!(
                        "{} holds the key \"{name}\", which Narsil does not accept there",
                        self.label
                    )));
                }
                None => {
                    return Err(config_invalid(format!(
                        "{} holds a key of type {}, where every key is a string",
                        self.label,
                        kind_of(&key)
                    )));
                }
            }
        }
        Ok(())
    }
}

pub(crate) fn choice_of<T: Copy>(
    name: &str,
    path: &str,
    choices: &[(&str, T)],
) -> Result<T, NarsilError> {
    choices
        .iter()
        .find(|(choice, _)| *choice == name)
        .map(|(_, variant)| *variant)
        .ok_or_else(|| {
            let names: Vec<String> = choices
                .iter()
                .map(|(choice, _)| format!("\"{choice}\""))
                .collect();
            config_invalid(format!(
                "{path} must be one of {}, and it is \"{name}\"",
                names.join(", ")
            ))
        })
}

fn any_number_of(value: &Bound<'_, PyAny>) -> Option<f64> {
    if value.cast::<PyBool>().is_ok() || value.cast::<PyString>().is_ok() {
        return None;
    }
    value.extract::<f64>().ok()
}

pub(crate) fn number_of(value: &Bound<'_, PyAny>, path: &str) -> Result<f64, NarsilError> {
    match any_number_of(value) {
        Some(number) if number.is_finite() => Ok(number),
        _ => Err(config_invalid(format!(
            "{path} must be a finite number, and it is a {}",
            kind_of(value)
        ))),
    }
}

pub(crate) fn whole_of(value: &Bound<'_, PyAny>, path: &str) -> Result<u64, NarsilError> {
    let refused = || {
        config_invalid(format!(
            "{path} must be a whole number from 0 to {MAX_SAFE_INTEGER}"
        ))
    };
    if value.cast::<PyBool>().is_ok() {
        return Err(refused());
    }
    if value.is_instance_of::<PyInt>() {
        let whole: u64 = value.extract().map_err(|_| refused())?;
        return if whole <= MAX_SAFE_INTEGER {
            Ok(whole)
        } else {
            Err(refused())
        };
    }
    if value.is_instance_of::<PyFloat>() {
        let number: f64 = value.extract().map_err(|_| refused())?;
        if number.is_finite()
            && number.fract() == 0.0
            && (0.0..=MAX_SAFE_INTEGER as f64).contains(&number)
        {
            return Ok(number as u64);
        }
    }
    Err(refused())
}

pub(crate) fn string_of(value: &Bound<'_, PyAny>, path: &str) -> Result<String, NarsilError> {
    value
        .cast::<PyString>()
        .ok()
        .and_then(|text| text.to_str().ok().map(str::to_string))
        .ok_or_else(|| {
            config_invalid(format!(
                "{path} must be a string, and it is a {}",
                kind_of(value)
            ))
        })
}

pub(crate) fn items_of<'py>(
    value: &Bound<'py, PyAny>,
    path: &str,
) -> Result<Vec<Bound<'py, PyAny>>, NarsilError> {
    if let Ok(list) = value.cast::<PyList>() {
        return Ok(list.iter().collect());
    }
    if let Ok(tuple) = value.cast::<PyTuple>() {
        return Ok(tuple.iter().collect());
    }
    let text_bytes_or_mapping = value.cast::<PyString>().is_ok()
        || value.cast::<PyBytes>().is_ok()
        || value.cast::<PyByteArray>().is_ok()
        || value.cast::<PyMapping>().is_ok();
    if !text_bytes_or_mapping && let Ok(iterator) = value.try_iter() {
        return iterator
            .collect::<PyResult<Vec<_>>>()
            .map_err(|error| config_invalid(format!("{path} cannot be read as a list: {error}")));
    }
    Err(config_invalid(format!(
        "{path} must be a list, and it is a {}",
        kind_of(value)
    )))
}

pub(crate) fn strings_of(value: &Bound<'_, PyAny>, path: &str) -> Result<Vec<String>, NarsilError> {
    items_of(value, path)?
        .iter()
        .enumerate()
        .map(|(at, item)| string_of(item, &format!("{path}[{at}]")))
        .collect()
}

pub(crate) fn floats_of(value: &Bound<'_, PyAny>, path: &str) -> Result<Vec<f32>, NarsilError> {
    let listed;
    let source = if value.cast::<PyList>().is_err() && value.hasattr("tolist").unwrap_or(false) {
        listed = value
            .call_method0("tolist")
            .map_err(|error| config_invalid(format!("{path} cannot be read as a list: {error}")))?;
        &listed
    } else {
        value
    };
    if source.cast::<PySet>().is_ok() || source.cast::<PyFrozenSet>().is_ok() {
        return Err(config_invalid(format!(
            "{path} must be a list of numbers, and it is a {}, which holds its numbers in no fixed order",
            kind_of(source)
        )));
    }
    items_of(source, path)?
        .iter()
        .enumerate()
        .map(|(at, item)| {
            any_number_of(item)
                .map(|number| number as f32)
                .ok_or_else(|| {
                    config_invalid(format!(
                        "{path}[{at}] must be a number, and it is a {}",
                        kind_of(item)
                    ))
                })
        })
        .collect()
}
