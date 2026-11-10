use super::number;
use crate::value::{Map, Value};

pub(crate) const DEFAULT_BM25_K1: f64 = 1.2;
pub(crate) const DEFAULT_BM25_B: f64 = 0.75;

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub(crate) struct FieldBm25 {
    pub(crate) k1: Option<f64>,
    pub(crate) b: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Bm25Params {
    pub(crate) k1: f64,
    pub(crate) b: f64,
    pub(crate) fields: Option<Vec<(String, FieldBm25)>>,
}

impl Default for Bm25Params {
    fn default() -> Bm25Params {
        Bm25Params {
            k1: DEFAULT_BM25_K1,
            b: DEFAULT_BM25_B,
            fields: None,
        }
    }
}

pub(crate) fn bm25_from_wire(value: Option<&Value>) -> Bm25Params {
    let Some(Value::Object(map)) = value else {
        return Bm25Params::default();
    };
    let fields = match map.get("fields") {
        Some(Value::Object(fields)) => Some(
            fields
                .iter()
                .map(|(name, entry)| {
                    let entry = entry.as_object();
                    let k1 = entry.and_then(|entry| number(entry.get("k1")));
                    let b = entry.and_then(|entry| number(entry.get("b")));
                    (name.clone(), FieldBm25 { k1, b })
                })
                .collect(),
        ),
        _ => None,
    };
    let fields = fields.filter(|fields: &Vec<(String, FieldBm25)>| !fields.is_empty());
    Bm25Params {
        k1: number(map.get("k1")).unwrap_or(DEFAULT_BM25_K1),
        b: number(map.get("b")).unwrap_or(DEFAULT_BM25_B),
        fields,
    }
}

pub(crate) fn bm25_to_wire(params: &Bm25Params) -> Value {
    let mut map = Map::new();
    map.insert("k1", Value::Number(params.k1));
    map.insert("b", Value::Number(params.b));
    if let Some(fields) = params.fields.as_ref().filter(|fields| !fields.is_empty()) {
        let mut wire = Map::new();
        for (name, field) in fields {
            let mut entry = Map::new();
            if let Some(k1) = field.k1 {
                entry.insert("k1", Value::Number(k1));
            }
            if let Some(b) = field.b {
                entry.insert("b", Value::Number(b));
            }
            wire.insert(name.clone(), Value::Object(entry));
        }
        map.insert("fields", Value::Object(wire));
    }
    Value::Object(map)
}
