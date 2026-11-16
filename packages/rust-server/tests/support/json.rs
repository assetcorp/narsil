use narsil::{Map, Value};

fn from_serde(json: serde_json::Value) -> Value {
    match json {
        serde_json::Value::Null => Value::Null,
        serde_json::Value::Bool(flag) => Value::Bool(flag),
        serde_json::Value::Number(number) => Value::Number(
            number
                .as_f64()
                .expect("serde_json reads every JSON number as a float64"),
        ),
        serde_json::Value::String(text) => Value::String(text),
        serde_json::Value::Array(items) => {
            Value::Array(items.into_iter().map(from_serde).collect())
        }
        serde_json::Value::Object(entries) => {
            let mut map = Map::new();
            for (key, value) in entries {
                map.insert(key, from_serde(value));
            }
            Value::Object(map)
        }
    }
}

fn to_serde(value: &Value) -> serde_json::Value {
    match value {
        Value::Null => serde_json::Value::Null,
        Value::Bool(flag) => serde_json::Value::Bool(*flag),
        Value::Number(number) => whole_or_float(*number),
        Value::String(text) => serde_json::Value::String(text.clone()),
        Value::Array(items) => serde_json::Value::Array(items.iter().map(to_serde).collect()),
        Value::Object(map) => serde_json::Value::Object(
            map.iter()
                .map(|(key, value)| (key.clone(), to_serde(value)))
                .collect(),
        ),
        Value::Bytes(_) | Value::Timestamp(_) => {
            panic!("a JSON request body holds no bytes and no timestamps")
        }
    }
}

fn whole_or_float(number: f64) -> serde_json::Value {
    const LARGEST_EXACT_WHOLE_NUMBER: f64 = 9_007_199_254_740_992.0;
    if number.fract() == 0.0 && number.abs() <= LARGEST_EXACT_WHOLE_NUMBER {
        return serde_json::Value::Number(serde_json::Number::from(number as i64));
    }
    serde_json::Number::from_f64(number).map_or(serde_json::Value::Null, serde_json::Value::Number)
}

pub fn decode_json(text: &str) -> Result<Value, serde_json::Error> {
    serde_json::from_str::<serde_json::Value>(text).map(from_serde)
}

pub fn encode_json(value: &Value) -> String {
    serde_json::to_string(&to_serde(value)).expect("serde_json writes every JSON value")
}
