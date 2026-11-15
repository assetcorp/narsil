use narsil::{
    Bm25FieldParams, Bm25Params, ErrorCode, HybridConfig, HybridStrategy, Metric, RerankConfig,
    Value, VectorQuery,
};

use crate::errors::ServerError;
use crate::search::reader::{
    Converted, Fields, details_of, refusal, safe_whole, size_of, strings_of,
};

const METRICS: [(&str, Metric); 3] = [
    ("cosine", Metric::Cosine),
    ("dotProduct", Metric::DotProduct),
    ("euclidean", Metric::Euclidean),
];
const HYBRID_STRATEGIES: [(&str, HybridStrategy); 2] = [
    ("rrf", HybridStrategy::Rrf),
    ("linear", HybridStrategy::Linear),
];

fn config_invalid(message: impl Into<String>) -> ServerError {
    refusal(ErrorCode::CONFIG_INVALID, message)
}

fn query_vector(value: &Value) -> Converted<Vec<f32>> {
    let Value::Array(items) = value else {
        return Err(refusal(
            ErrorCode::DOC_VALIDATION_FAILED,
            "Vector query 'value' must be an array of numbers",
        ));
    };
    items
        .iter()
        .enumerate()
        .map(|(at, item)| {
            let narrowed = item.as_f64().map(|number| number as f32);
            narrowed.filter(|number| number.is_finite()).ok_or_else(|| {
                refusal(
                    ErrorCode::DOC_VALIDATION_FAILED,
                    format!(
                        "Vector query 'value' element at index {at} is not a number that a 32-bit float holds as a finite value"
                    ),
                )
            })
        })
        .collect()
}

fn whole_or(fields: &Fields<'_>, key: &str, message: &str) -> Converted<Option<u32>> {
    match fields.present(key) {
        None => Ok(None),
        Some(value) => safe_whole(value)
            .and_then(|whole| u32::try_from(whole).ok())
            .map(Some)
            .ok_or_else(|| {
                config_invalid(message).with_details(details_of(vec![(key, value.clone())]))
            }),
    }
}

fn number_or(fields: &Fields<'_>, key: &str, message: &str) -> Converted<Option<f64>> {
    match fields.present(key) {
        None => Ok(None),
        Some(Value::Number(number)) => Ok(Some(*number)),
        Some(_) => Err(config_invalid(message)),
    }
}

pub(crate) fn vector_query(vector: &Value, mode: Option<&Value>) -> Converted<VectorQuery> {
    let Value::Object(vector) = vector else {
        return Err(config_invalid("Field \"vector\" must be an object"));
    };
    let fields = Fields::new(vector, "vector");
    let field = match fields.present("field") {
        Some(Value::String(field)) => field.clone(),
        None => {
            let mode = mode.and_then(Value::as_str).unwrap_or("undefined");
            return Err(refusal(
                ErrorCode::SEARCH_INVALID_MODE,
                format!("A \"{mode}\" query needs a vector clause naming the field to search"),
            ));
        }
        Some(_) => {
            return Err(fields.wrong("field", ErrorCode::SEARCH_INVALID_FIELD, "a string"));
        }
    };
    let value = fields.present("value");
    let text = fields.present("text");
    if value.is_some() && text.is_some() {
        return Err(refusal(
            ErrorCode::EMBEDDING_CONFIG_INVALID,
            "Vector query cannot have both 'text' and 'value'",
        ));
    }
    let text = match text {
        None => None,
        Some(Value::String(text)) => Some(text.clone()),
        Some(_) => {
            return Err(refusal(
                ErrorCode::DOC_VALIDATION_FAILED,
                "Vector query 'text' must be a string",
            ));
        }
    };
    Ok(VectorQuery {
        field,
        value: value.map(query_vector).transpose()?,
        text,
        similarity: fields.number("similarity", ErrorCode::CONFIG_INVALID)?,
        metric: fields.choice("metric", ErrorCode::CONFIG_INVALID, &METRICS)?,
        ef_search: whole_or(
            &fields,
            "efSearch",
            "vector.efSearch must be a whole number from 1 to 10000",
        )?,
        oversample: number_or(
            &fields,
            "oversample",
            "vector.oversample must be a finite number of at least 1",
        )?,
    })
}

pub(crate) fn hybrid_config(hybrid: &Value) -> Converted<HybridConfig> {
    let Value::Object(hybrid) = hybrid else {
        return Err(config_invalid("Field \"hybrid\" must be an object"));
    };
    let fields = Fields::new(hybrid, "hybrid");
    let strategy = match fields.get("strategy") {
        None => None,
        Some(value) => Some(
            value
                .as_str()
                .and_then(|text| HYBRID_STRATEGIES.iter().find(|(name, _)| *name == text))
                .map(|(_, strategy)| *strategy)
                .ok_or_else(|| config_invalid("hybrid.strategy must be \"rrf\" or \"linear\""))?,
        ),
    };
    let depth = match fields.get("depth") {
        None => None,
        Some(value) => Some(size_of(value).ok_or_else(|| {
            config_invalid("hybrid.depth must be a whole number from 1 to 10000")
                .with_details(details_of(vec![("depth", value.clone())]))
        })?),
    };
    Ok(HybridConfig {
        strategy,
        k: number_or(
            &fields,
            "k",
            "hybrid.k must be a whole number of at least 1",
        )?,
        alpha: number_or(
            &fields,
            "alpha",
            "hybrid.alpha must be a number from 0 to 1",
        )?,
        depth,
    })
}

fn rerank_invalid(message: impl Into<String>) -> ServerError {
    refusal(ErrorCode::RERANK_CONFIG_INVALID, message)
}

fn rerank_refusal() -> ServerError {
    rerank_invalid("rerank must be an object that gives an adapter and the fields to rerank by")
}

pub(crate) fn rerank_config(rerank: &Value, max_rerank_window: usize) -> Converted<RerankConfig> {
    let Value::Object(rerank) = rerank else {
        return Err(rerank_refusal());
    };
    let adapter = match rerank.get("adapter") {
        Some(Value::String(adapter)) if !adapter.is_empty() => adapter.clone(),
        _ => {
            return Err(rerank_invalid(
                "rerank.adapter must give the name of a registered rerank adapter",
            ));
        }
    };
    let fields = rerank
        .get("fields")
        .and_then(strings_of)
        .filter(|fields| !fields.is_empty())
        .ok_or_else(|| rerank_invalid("rerank.fields must list at least one text field"))?;
    let query = match rerank.get("query") {
        None => None,
        Some(Value::String(query)) => Some(query.clone()),
        Some(_) => return Err(rerank_invalid("rerank.query must be a string")),
    };
    let window = match rerank.get("window") {
        None => None,
        Some(window) => Some(size_of(window).ok_or_else(|| {
            rerank_invalid(format!(
                "rerank.window must be a whole number from 1 to {max_rerank_window}"
            ))
            .with_details(details_of(vec![
                ("window", window.clone()),
                ("maxRerankWindow", Value::Number(max_rerank_window as f64)),
            ]))
        })?),
    };
    Ok(RerankConfig {
        adapter,
        fields,
        query,
        window,
    })
}

fn bm25_refusal() -> ServerError {
    config_invalid("bm25 must be an object that sets k1, b, or fields")
}

fn bm25_pair(fields: &Fields<'_>) -> Converted<Bm25FieldParams> {
    let parameter = |key: &str| match fields.present(key) {
        None => Ok(None),
        Some(Value::Number(number)) => Ok(Some(*number)),
        Some(_) => Err(config_invalid(format!(
            "{} must be a finite number",
            fields.path(key)
        ))),
    };
    Ok(Bm25FieldParams {
        k1: parameter("k1")?,
        b: parameter("b")?,
    })
}

pub(crate) fn bm25_params(bm25: &Value) -> Converted<Bm25Params> {
    let Value::Object(bm25) = bm25 else {
        return Err(bm25_refusal());
    };
    let fields = Fields::new(bm25, "bm25");
    let pair = bm25_pair(&fields)?;
    let per_field = match fields.present("fields") {
        None => None,
        Some(Value::Object(named)) => Some(
            named
                .iter()
                .map(|(name, entry)| {
                    let Value::Object(entry) = entry else {
                        return Err(config_invalid(format!(
                            "bm25.fields.{name} must be an object that sets k1 or b"
                        )));
                    };
                    Ok((
                        name.clone(),
                        bm25_pair(&Fields::new(entry, format!("bm25.fields.{name}")))?,
                    ))
                })
                .collect::<Converted<Vec<_>>>()?,
        ),
        Some(_) => {
            return Err(config_invalid(
                "bm25.fields must be an object keyed by field name",
            ));
        }
    };
    Ok(Bm25Params {
        k1: pair.k1,
        b: pair.b,
        fields: per_field,
    })
}
