use narsil::{
    HybridConfig, HybridStrategy, Metric, Pin, QueryParams, RerankConfig, SearchMode, Value,
    VectorQuery,
};

fn text(value: &Value, name: &str) -> Option<String> {
    value
        .pointer(name)
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn number(value: &Value, name: &str) -> Option<f64> {
    value.pointer(name).and_then(Value::as_f64)
}

fn vector_of(value: &Value) -> Vec<f32> {
    value
        .as_array()
        .expect("a vector is a list")
        .iter()
        .map(|element| element.as_f64().expect("a vector element") as f32)
        .collect()
}

fn metric(name: &str) -> Metric {
    match name {
        "dotProduct" => Metric::DotProduct,
        "euclidean" => Metric::Euclidean,
        _ => Metric::Cosine,
    }
}

fn vector_clause(clause: &Value) -> VectorQuery {
    VectorQuery {
        field: text(clause, "field").expect("a vector field"),
        value: clause.pointer("value").map(vector_of),
        text: text(clause, "text"),
        similarity: number(clause, "similarity"),
        metric: text(clause, "metric").map(|name| metric(&name)),
        ef_search: number(clause, "efSearch").map(|ef| ef as u32),
        oversample: number(clause, "oversample"),
    }
}

fn hybrid_config(hybrid: &Value) -> HybridConfig {
    HybridConfig {
        strategy: text(hybrid, "strategy").map(|name| match name.as_str() {
            "linear" => HybridStrategy::Linear,
            _ => HybridStrategy::Rrf,
        }),
        k: number(hybrid, "k"),
        alpha: number(hybrid, "alpha"),
        depth: number(hybrid, "depth").map(|depth| depth as usize),
    }
}

fn pins(pinned: &Value) -> Vec<Pin> {
    pinned
        .as_array()
        .expect("a list of pins")
        .iter()
        .map(|pin| Pin {
            doc_id: text(pin, "docId").expect("a pinned ID"),
            position: number(pin, "position").expect("a position") as usize,
        })
        .collect()
}

fn rerank_config(rerank: &Value) -> RerankConfig {
    RerankConfig {
        adapter: text(rerank, "adapter").unwrap_or_default(),
        fields: rerank
            .pointer("fields")
            .and_then(Value::as_array)
            .map(|fields| {
                fields
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
        query: text(rerank, "query"),
        window: number(rerank, "window").map(|window| window as usize),
    }
}

pub fn vector_params(query: &Value) -> QueryParams {
    QueryParams {
        mode: text(query, "mode").map(|mode| match mode.as_str() {
            "vector" => SearchMode::Vector,
            "hybrid" => SearchMode::Hybrid,
            _ => SearchMode::Fulltext,
        }),
        vector: query.pointer("vector").map(vector_clause),
        hybrid: query.pointer("hybrid").map(hybrid_config),
        rerank: query.pointer("rerank").map(rerank_config),
        pinned: query.pointer("pinned").map(pins),
        ..QueryParams::default()
    }
}
