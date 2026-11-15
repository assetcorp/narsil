use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};

use super::constants::{LARGEST_SAFE_INTEGER, MAX_LIST_ITEMS, VARIABLE_PREFIX};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingError {
    pub variable: String,
    pub rule: String,
}

impl SettingError {
    pub fn new(variable: &str, rule: impl Into<String>) -> SettingError {
        SettingError {
            variable: variable.to_string(),
            rule: rule.into(),
        }
    }

    pub fn line(&self) -> String {
        format!("{} {}", self.variable, self.rule)
    }
}

pub type Setting<T> = Result<T, SettingError>;

#[derive(Debug, Clone)]
enum EnvironmentValue {
    Text(String),
    NotUnicode,
}

#[derive(Debug, Clone, Default)]
pub struct Environment {
    values: BTreeMap<String, EnvironmentValue>,
}

impl Environment {
    pub fn from_process() -> Environment {
        let mut values = BTreeMap::new();
        for (name, value) in std::env::vars_os() {
            let Ok(name) = name.into_string() else {
                continue;
            };
            let value = match value.into_string() {
                Ok(text) => EnvironmentValue::Text(text),
                Err(_) => EnvironmentValue::NotUnicode,
            };
            values.insert(name, value);
        }
        Environment { values }
    }
}

pub struct WholeNumberRange {
    pub min: u64,
    pub max: Option<u64>,
}

fn range_rule(min: u64, max: Option<u64>) -> String {
    match max {
        None => format!("must be a whole number of at least {min}"),
        Some(max) => format!("must be a whole number from {min} to {max}"),
    }
}

fn is_decimal(raw: &str) -> bool {
    let (whole, fraction) = match raw.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (raw, None),
    };
    let digits = |part: &str| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit());
    digits(whole) && fraction.is_none_or(digits)
}

pub struct VariableReader<'a> {
    environment: &'a Environment,
    consulted: RefCell<BTreeSet<String>>,
}

impl<'a> VariableReader<'a> {
    pub fn new(environment: &'a Environment) -> VariableReader<'a> {
        VariableReader {
            environment,
            consulted: RefCell::new(BTreeSet::new()),
        }
    }

    pub fn text(&self, name: &str) -> Setting<Option<String>> {
        self.consulted.borrow_mut().insert(name.to_string());
        match self.environment.values.get(name) {
            None => Ok(None),
            Some(EnvironmentValue::NotUnicode) => {
                Err(SettingError::new(name, "must be UTF-8 text"))
            }
            Some(EnvironmentValue::Text(text)) if text.is_empty() => Ok(None),
            Some(EnvironmentValue::Text(text)) => Ok(Some(text.clone())),
        }
    }

    pub fn whole_number(&self, name: &str, range: WholeNumberRange) -> Setting<Option<u64>> {
        let Some(raw) = self.text(name)? else {
            return Ok(None);
        };
        if !raw.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(SettingError::new(name, range_rule(range.min, range.max)));
        }
        let max = range.max.unwrap_or(LARGEST_SAFE_INTEGER);
        match raw.parse::<u64>() {
            Ok(value) if value >= range.min && value <= max && value <= LARGEST_SAFE_INTEGER => {
                Ok(Some(value))
            }
            _ => Err(SettingError::new(name, range_rule(range.min, Some(max)))),
        }
    }

    pub fn decimal(&self, name: &str, min: f64, max: f64) -> Setting<Option<f64>> {
        let Some(raw) = self.text(name)? else {
            return Ok(None);
        };
        let value = if is_decimal(&raw) {
            raw.parse::<f64>().unwrap_or(f64::NAN)
        } else {
            f64::NAN
        };
        if !value.is_finite() || value < min || value > max {
            return Err(SettingError::new(
                name,
                format!("must be a decimal from {min} to {max}"),
            ));
        }
        Ok(Some(value))
    }

    pub fn boolean(&self, name: &str) -> Setting<Option<bool>> {
        match self.text(name)?.as_deref() {
            None => Ok(None),
            Some("true") => Ok(Some(true)),
            Some("false") => Ok(Some(false)),
            Some(_) => Err(SettingError::new(name, "must be true or false")),
        }
    }

    pub fn list(&self, name: &str) -> Setting<Option<Vec<String>>> {
        let Some(raw) = self.text(name)? else {
            return Ok(None);
        };
        let items: Vec<String> = raw.split(',').map(|item| item.trim().to_string()).collect();
        if items.iter().any(String::is_empty) {
            return Err(SettingError::new(
                name,
                "must be items separated by commas, with no empty item",
            ));
        }
        if items.len() > MAX_LIST_ITEMS {
            return Err(SettingError::new(
                name,
                format!("must hold at most {MAX_LIST_ITEMS} items"),
            ));
        }
        Ok(Some(items))
    }

    pub fn one_of(&self, name: &str, choices: &[&'static str]) -> Setting<Option<&'static str>> {
        let Some(raw) = self.text(name)? else {
            return Ok(None);
        };
        match choices.iter().find(|choice| **choice == raw) {
            Some(choice) => Ok(Some(choice)),
            None => Err(SettingError::new(
                name,
                format!("must be {}", choices.join(" or ")),
            )),
        }
    }

    pub fn is_set(&self, name: &str) -> Setting<bool> {
        Ok(self.text(name)?.is_some())
    }

    pub fn unconsulted_names(&self) -> Vec<String> {
        let consulted = self.consulted.borrow();
        self.environment
            .values
            .keys()
            .filter(|name| name.starts_with(VARIABLE_PREFIX) && !consulted.contains(*name))
            .cloned()
            .collect()
    }
}
