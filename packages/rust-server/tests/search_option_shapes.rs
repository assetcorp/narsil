mod support;

use narsil::{Map, Value};
use narsil_server::ServerOptions;
use support::{
    Call, ReferenceServer, RustServer, decode_json, encode_json, object, parsed, repository_root,
    send,
};

const SCHEMA: &str = r#"{"title":"string","tag":"enum","year":"number","embedding":"vector[2]"}"#;
const NOTES: [(&str, &str); 3] = [
    (
        "a",
        r#"{"title":"harbor stone","tag":"x","year":2020,"embedding":[0.1,0.2]}"#,
    ),
    (
        "b",
        r#"{"title":"stone river","tag":"y","year":1999,"embedding":[0.3,0.1]}"#,
    ),
    (
        "c",
        r#"{"title":"harbor light","tag":"x","year":2011,"embedding":[0.2,0.4]}"#,
    ),
];
const HOSTILE_VALUES: &str = r#"[null,true,0,5,-1,1.5,"x",[],["x"],{}]"#;
const MAX_LISTED_DIFFERENCES: usize = 25;
const UNKNOWN_BM25_KEYS: [&str; 2] = [
    r#"{"term":"alpha","bm25":{"bogus":1}}"#,
    r#"{"bm25":{"fields":{"title":{"bogus":1}}}}"#,
];

struct Frame {
    body: &'static str,
    target: &'static [&'static str],
    schema: &'static [&'static str],
}

const FRAMES: [Frame; 13] = [
    Frame {
        body: r#"{"term":"harbor"}"#,
        target: &[],
        schema: &["HttpQueryParams"],
    },
    Frame {
        body: r#"{"term":"harbor","bm25":{"k1":1.2}}"#,
        target: &["bm25"],
        schema: &["BM25Params"],
    },
    Frame {
        body: r#"{"term":"harbor","bm25":{"fields":{"title":{}}}}"#,
        target: &["bm25", "fields", "title"],
        schema: &["BM25FieldParams"],
    },
    Frame {
        body: r#"{"term":"harbor","facets":{"tag":{}}}"#,
        target: &["facets", "tag"],
        schema: &["FacetConfig", "additionalProperties"],
    },
    Frame {
        body: r#"{"term":"harbor","facets":{"year":{"ranges":[{"from":0,"to":3000}]}}}"#,
        target: &["facets", "year", "ranges", "0"],
        schema: &[
            "FacetConfig",
            "additionalProperties",
            "properties",
            "ranges",
            "items",
        ],
    },
    Frame {
        body: r#"{"term":"harbor","sort":[{"field":"year","direction":"asc"}]}"#,
        target: &["sort", "0"],
        schema: &["SortField"],
    },
    Frame {
        body: r#"{"term":"harbor","highlight":{"fields":["title"]}}"#,
        target: &["highlight"],
        schema: &["HighlightConfig"],
    },
    Frame {
        body: r#"{"term":"harbor","pinned":[{"docId":"b","position":0}]}"#,
        target: &["pinned", "0"],
        schema: &["HttpQueryParams", "properties", "pinned", "items"],
    },
    Frame {
        body: r#"{"vector":{"field":"embedding","value":[0.1,0.2]}}"#,
        target: &["vector"],
        schema: &["VectorQueryConfig"],
    },
    Frame {
        body: r#"{"term":"harbor","mode":"hybrid","vector":{"field":"embedding","value":[0.1,0.2]},"hybrid":{"alpha":0.5}}"#,
        target: &["hybrid"],
        schema: &["HybridConfig"],
    },
    Frame {
        body: r#"{"term":"harbor","rerank":{"adapter":"unregistered","fields":["title"]}}"#,
        target: &["rerank"],
        schema: &["RerankConfig"],
    },
    Frame {
        body: r#"{"term":"harbor","document":{"include":["title"]}}"#,
        target: &["document"],
        schema: &["HttpQueryParams", "properties", "document", "anyOf", "1"],
    },
    Frame {
        body: r#"{"term":"harbor","group":{"fields":["tag"]}}"#,
        target: &["group"],
        schema: &["HttpQueryParams", "properties", "group"],
    },
];

fn step<'v>(value: &'v Value, key: &str) -> Option<&'v Value> {
    match value {
        Value::Object(map) => map.get(key),
        Value::Array(items) => key.parse::<usize>().ok().and_then(|at| items.get(at)),
        _ => None,
    }
}

fn resolved<'v>(schemas: &'v Value, mut schema: &'v Value) -> &'v Value {
    while let Some(reference) = step(schema, "$ref").and_then(Value::as_str) {
        let name = reference.rsplit('/').next().unwrap_or(reference);
        schema = step(schemas, name).unwrap_or_else(|| panic!("openapi.json defines {name}"));
    }
    schema
}

fn properties_of(schemas: &Value, path: &[&str]) -> Vec<String> {
    let mut schema = schemas;
    for key in path {
        schema = resolved(schemas, schema);
        schema = step(schema, key).unwrap_or_else(|| panic!("openapi.json holds {path:?}"));
    }
    let schema = resolved(schemas, schema);
    step(schema, "properties")
        .and_then(Value::as_object)
        .unwrap_or_else(|| panic!("{path:?} lists its properties"))
        .keys()
        .cloned()
        .collect()
}

fn target_mut<'v>(body: &'v mut Value, path: &[&str]) -> &'v mut Map {
    let mut place = body;
    for key in path {
        place = match place {
            Value::Object(map) => map.get_mut(key),
            Value::Array(items) => key
                .parse::<usize>()
                .ok()
                .and_then(move |at| items.get_mut(at)),
            _ => None,
        }
        .unwrap_or_else(|| panic!("the frame body holds {path:?}"));
    }
    place
        .as_object_mut()
        .unwrap_or_else(|| panic!("{path:?} is an object in the frame body"))
}

fn hostile_bodies() -> Vec<Value> {
    let openapi_path = repository_root().join("packages/ts/openapi.json");
    let openapi = std::fs::read_to_string(&openapi_path).expect("openapi.json is readable");
    let openapi = decode_json(&openapi).expect("openapi.json is JSON");
    let schemas = step(&openapi, "components")
        .and_then(|components| step(components, "schemas"))
        .expect("openapi.json defines its schemas");
    let values = parsed(HOSTILE_VALUES);
    let values = values.as_array().expect("the hostile values are a list");
    let mut bodies = Vec::new();
    for frame in &FRAMES {
        for property in properties_of(schemas, frame.schema) {
            for value in values {
                let mut body = parsed(frame.body);
                target_mut(&mut body, frame.target).insert(property.clone(), value.clone());
                bodies.push(body);
            }
        }
        let mut emptied = parsed(frame.body);
        *target_mut(&mut emptied, frame.target) = Map::new();
        bodies.push(emptied);
    }
    bodies.extend(UNKNOWN_BM25_KEYS.iter().map(|body| parsed(body)));
    bodies
}

async fn store_notes(port: u16) {
    let created = send(
        port,
        &Call::new("POST", "/indexes").json(&object(vec![
            ("name", Value::from("notes")),
            ("config", object(vec![("schema", parsed(SCHEMA))])),
        ])),
    )
    .await;
    assert_eq!(created.status, 201, "the server creates the notes index");
    for (id, fields) in NOTES {
        let target = format!("/indexes/notes/documents/{id}");
        let stored = send(
            port,
            &Call::new("PUT", &target).json(&object(vec![("document", parsed(fields))])),
        )
        .await;
        assert_eq!(stored.status, 201, "the server stores note {id}");
    }
}

fn answer_of(status: u16, body: &[u8]) -> String {
    let text = String::from_utf8_lossy(body);
    let mut value = decode_json(&text).unwrap_or(Value::String(text.to_string()));
    if let Value::Object(map) = &mut value {
        map.remove("elapsed");
    }
    format!("{status} {}", encode_json(&value))
}

#[tokio::test(flavor = "multi_thread")]
async fn every_search_option_of_every_type_answers_as_the_typescript_server_answers() {
    let rust = RustServer::in_memory(ServerOptions::default()).await;
    let reference = ReferenceServer::start(object(vec![])).await;
    store_notes(rust.port).await;
    store_notes(reference.port).await;

    let bodies = hostile_bodies();
    let mut differences = Vec::new();
    for body in &bodies {
        for route in ["/indexes/notes/search", "/indexes/notes/search/preflight"] {
            let call = Call::new("POST", route).json(body);
            let (mine, theirs) = tokio::join!(send(rust.port, &call), send(reference.port, &call));
            let (mine, theirs) = (
                answer_of(mine.status, &mine.body),
                answer_of(theirs.status, &theirs.body),
            );
            if theirs.starts_with("500 ") || mine != theirs {
                differences.push(format!(
                    "{route} {}\n  rust:       {mine}\n  typescript: {theirs}",
                    encode_json(body)
                ));
            }
        }
    }

    reference.stop().await;
    rust.stop().await;
    let listed: Vec<&String> = differences.iter().take(MAX_LISTED_DIFFERENCES).collect();
    assert!(
        differences.is_empty(),
        "{} of {} answers differ or fail with 500:\n{}",
        differences.len(),
        bodies.len() * 2,
        listed
            .iter()
            .map(|line| line.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    );
}
