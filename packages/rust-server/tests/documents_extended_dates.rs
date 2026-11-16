mod support;

use narsil::{IndexConfig, Map, Narsil, Timestamp, Value};
use narsil_server::ServerOptions;
use support::{Call, RustServer, object, send};

const INDEX: &str = "calendar";
const DOCUMENT_ID: &str = "span";
const YEAR_BEFORE_ZERO_SECONDS: i64 = -62_198_755_200;
const YEAR_TEN_THOUSAND_SECONDS: i64 = 253_402_300_800;
const YEAR_BEFORE_ZERO_TEXT: &str = "-000001-01-01T00:00:00.000Z";
const YEAR_TEN_THOUSAND_TEXT: &str = "+010000-01-01T00:00:00.000Z";

fn moment(seconds: i64) -> Value {
    Value::Timestamp(Timestamp {
        seconds,
        nanoseconds: 0,
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stored_date_beyond_four_digit_years_reads_back_as_javascript_writes_it() {
    let engine = Narsil::new();
    let mut schema = Map::new();
    schema.insert("title", Value::String("string".to_string()));
    engine
        .create_index(
            INDEX,
            IndexConfig {
                schema: Value::Object(schema),
                ..IndexConfig::default()
            },
        )
        .expect("the index is created");
    let mut document = Map::new();
    document.insert("title", Value::String("dated span".to_string()));
    document.insert("before", moment(YEAR_BEFORE_ZERO_SECONDS));
    document.insert("after", moment(YEAR_TEN_THOUSAND_SECONDS));
    engine
        .insert(INDEX, document, Some(DOCUMENT_ID))
        .expect("the engine stores both dates");
    let rust = RustServer::start(engine, ServerOptions::default()).await;

    let path = format!("/indexes/{INDEX}/documents/{DOCUMENT_ID}");
    let reply = send(rust.port, &Call::new("GET", &path)).await;
    assert_eq!(
        reply.status,
        200,
        "{:?}",
        String::from_utf8_lossy(&reply.body)
    );
    let expected = object(vec![(
        "document",
        object(vec![
            ("title", Value::String("dated span".to_string())),
            ("before", Value::String(YEAR_BEFORE_ZERO_TEXT.to_string())),
            ("after", Value::String(YEAR_TEN_THOUSAND_TEXT.to_string())),
        ]),
    )]);
    assert_eq!(reply.json(), expected);
    rust.stop().await;
}
