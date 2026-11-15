mod settings_support;
mod support;

use narsil::Value;
use settings_support::{
    INDEX, feed_options, field, reference_spec, rust_durable, same_error, seed_reference,
};
use support::{Call, ReferenceServer, ScratchDirectory, send};

const NOTES: usize = 3;
const FALSY_BODIES: [&str; 5] = ["null", "false", "0", "-0", "\"\""];

async fn falsy_bodies_are_refused(rust: u16, path: &str) {
    for body in FALSY_BODIES {
        let reply = send(rust, &raw_call("POST", path, body)).await;
        assert_eq!(
            (reply.status, reply.error_code().as_deref()),
            (400, Some("INVALID_REQUEST")),
            "{path} refuses the body {body}, where the TypeScript server never answers"
        );
    }
}

fn raw_call<'a>(method: &'a str, path: &'a str, body: &str) -> Call<'a> {
    Call::new(method, path)
        .authorized()
        .header("content-type", "application/json")
        .raw(body.to_string())
}

async fn compare_bodies(rust: u16, reference: u16, method: &str, path: &str, bodies: &[&str]) {
    for body in bodies {
        same_error(rust, reference, &raw_call(method, path, body)).await;
    }
}

async fn paired_servers(scratch: &ScratchDirectory) -> (support::RustServer, ReferenceServer) {
    let rust = rust_durable(
        &scratch.path().join("rust"),
        NOTES,
        feed_options(false, false),
    )
    .await;
    let reference_directory = scratch.path().join("reference");
    let reference =
        ReferenceServer::start(reference_spec(Some(&reference_directory), false, false)).await;
    seed_reference(&reference, NOTES).await;
    (rust, reference)
}

#[tokio::test(flavor = "multi_thread")]
async fn hostile_bm25_bodies_get_the_answers_of_the_typescript_server() {
    let scratch = ScratchDirectory::new("settings-bm25");
    let (rust, reference) = paired_servers(&scratch).await;
    let path = format!("/indexes/{INDEX}/bm25");
    compare_bodies(
        rust.port,
        reference.port,
        "POST",
        &path,
        &[
            "",
            "{",
            "null",
            "[]",
            "5",
            "\"k1\"",
            r#"{"x":1}"#,
            r#"{"k1":"1"}"#,
            r#"{"k1":-1}"#,
            r#"{"k1":1001}"#,
            r#"{"k1":null}"#,
            r#"{"k1":1e400}"#,
            r#"{"k1":true,"b":2}"#,
            r#"{"k1":1,"b":2}"#,
            r#"{"b":[1]}"#,
            r#"{"fields":5}"#,
            r#"{"fields":[]}"#,
            r#"{"fields":null}"#,
            r#"{"fields":{"title":5}}"#,
            r#"{"fields":{"title":{"x":1}}}"#,
            r#"{"fields":{"title":{"k1":"a"}}}"#,
            r#"{"fields":{"title":{"k1":2000}}}"#,
            r#"{"fields":{"price":{"k1":1}}}"#,
            r#"{"fields":{"embedding":{"k1":"a"}}}"#,
            r#"{"fields":{"ghost":{"k1":1}}}"#,
            r#"{"fields":{"ghost":{"k1":"a"}}}"#,
            r#"{"fields":{"title":{"k1":1},"ghost":{"k1":"a"}}}"#,
            r#"{"fields":{"title":{"k1":5000},"tags":{"k1":"a"}}}"#,
            r#"{"fields":{"title":{"k1":"a"},"1":{"k1":1}}}"#,
            r#"{"x":1,"k1":5000}"#,
            r#"{"k1":1.2,"b":0.75,"fields":{"title":{"k1":1.5,"b":0.5},"tags":{}}}"#,
            r#"{}"#,
        ],
    )
    .await;
    compare_bodies(
        rust.port,
        reference.port,
        "POST",
        "/indexes/ghost/bm25",
        &[
            r#"{"k1":"bad"}"#,
            r#"{"fields":{"title":{"k1":"a"}}}"#,
            "null",
        ],
    )
    .await;
    reference.stop().await;
    rust.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn hostile_partition_settings_get_the_answers_of_the_typescript_server() {
    let scratch = ScratchDirectory::new("settings-partition");
    let (rust, reference) = paired_servers(&scratch).await;
    let path = format!("/indexes/{INDEX}/partition-config");
    compare_bodies(
        rust.port,
        reference.port,
        "POST",
        &path,
        &[
            "{",
            r#"{"maxDocsPerPartition":0}"#,
            r#"{"maxDocsPerPartition":-1}"#,
            r#"{"maxDocsPerPartition":1.5}"#,
            r#"{"maxDocsPerPartition":"5"}"#,
            r#"{"maxDocsPerPartition":null}"#,
            r#"{"maxDocsPerPartition":true}"#,
            r#"{"maxDocsPerPartition":1}"#,
            r#"{"maxPartitions":0}"#,
            r#"{"maxPartitions":65537}"#,
            r#"{"maxPartitions":1.5}"#,
            r#"{"maxPartitions":"2"}"#,
            r#"{"watermark":0}"#,
            r#"{"watermark":1.5}"#,
            r#"{"watermark":"0.5"}"#,
            r#"{"watermark":null}"#,
            r#"{"watermark":1e400}"#,
            r#"{"maxDocsPerPartition":"x","maxPartitions":0}"#,
            r#"{"maxPartitions":"x","watermark":5}"#,
            r#"[]"#,
            r#"5"#,
            r#""settings""#,
            r#"{"maxDocsPerPartition":1000,"maxPartitions":4,"watermark":0.5}"#,
            r#"{"maxPartitions":1}"#,
            "",
        ],
    )
    .await;
    compare_bodies(
        rust.port,
        reference.port,
        "POST",
        "/indexes/ghost/partition-config",
        &[r#"{"maxDocsPerPartition":"5"}"#, r#"{"watermark":0.5}"#, ""],
    )
    .await;
    falsy_bodies_are_refused(rust.port, &path).await;
    reference.stop().await;
    rust.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn hostile_synonym_sets_get_the_answers_of_the_typescript_server() {
    let scratch = ScratchDirectory::new("settings-synonyms");
    let (rust, reference) = paired_servers(&scratch).await;
    let path = format!("/indexes/{INDEX}/synonyms");
    let too_many_rules = format!(r#"{{"synonyms":[{}]}}"#, vec!["{}"; 100_001].join(","));
    let hundred_words = format!(r#"{{"words":[{}]}}"#, vec![r#""w""#; 100].join(","));
    let too_many_words = format!(
        r#"{{"synonyms":[{}]}}"#,
        vec![hundred_words.as_str(); 5_001].join(",")
    );
    compare_bodies(
        rust.port,
        reference.port,
        "POST",
        &path,
        &[
            "",
            "{",
            "[]",
            "null",
            r#"{"rules":[]}"#,
            r#"{"synonyms":5}"#,
            r#"{"synonyms":null}"#,
            r#"{"synonyms":{}}"#,
            r#"{"synonyms":[5]}"#,
            r#"{"synonyms":[[]]}"#,
            r#"{"synonyms":[{"words":["coat"]}]}"#,
            r#"{"synonyms":[{"words":["coat",5]}]}"#,
            r#"{"synonyms":[{"words":"coat"}]}"#,
            r#"{"synonyms":[{"word":"car"}]}"#,
            r#"{"synonyms":[{"word":"car","synonyms":[]}]}"#,
            r#"{"synonyms":[{"word":5,"synonyms":["auto"]}]}"#,
            r#"{"synonyms":[{"words":["co\u0001at","jacket"]}]}"#,
            r#"{"synonyms":[{"words":["coat","jacket"],"x":1}]}"#,
            r#"{"synonyms":[{"words":["coat","jacket"]},{"words":["a"]}]}"#,
            r#"{"synonyms":[{"words":["two words","jacket"]}]}"#,
            &too_many_rules,
            &too_many_words,
            r#"{"synonyms":[{"words":["coat","jacket"]},{"word":"car","synonyms":["automobile"]}]}"#,
        ],
    )
    .await;
    let read = Call::new("GET", &path).authorized();
    let mine = send(rust.port, &read).await;
    let theirs = send(reference.port, &read).await;
    assert_eq!((mine.status, mine.json()), (theirs.status, theirs.json()));
    assert_eq!(
        field(&mine.json(), "synonyms").map(|rules| match rules {
            Value::Array(rules) => rules.len(),
            _ => 0,
        }),
        Some(2),
        "the set that the caller stored is the set that the server reads back"
    );
    compare_bodies(
        rust.port,
        reference.port,
        "POST",
        &path,
        &[r#"{"synonyms":[]}"#],
    )
    .await;
    let cleared = send(rust.port, &read).await;
    assert_eq!(cleared.json(), send(reference.port, &read).await.json());
    for call in [
        raw_call("POST", "/indexes/ghost/synonyms", r#"{"synonyms":5}"#),
        raw_call("POST", "/indexes/ghost/synonyms", "[]"),
        Call::new("GET", "/indexes/ghost/synonyms").authorized(),
    ] {
        same_error(rust.port, reference.port, &call).await;
    }
    reference.stop().await;
    rust.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn vector_upkeep_and_checkpoints_answer_as_the_typescript_server_does() {
    let scratch = ScratchDirectory::new("settings-vectors");
    let (rust, reference) = paired_servers(&scratch).await;
    let path = format!("/indexes/{INDEX}/vectors/_compact");
    compare_bodies(
        rust.port,
        reference.port,
        "POST",
        &path,
        &[
            "",
            "{",
            "{}",
            "[]",
            "5",
            "\"embedding\"",
            "true",
            r#"{"field":"embedding"}"#,
            r#"{"field":"ghost"}"#,
            r#"{"field":"title"}"#,
            r#"{"field":5}"#,
            r#"{"field":null}"#,
            r#"{"field":[1,2]}"#,
            r#"{"field":{}}"#,
        ],
    )
    .await;
    compare_bodies(
        rust.port,
        reference.port,
        "POST",
        "/indexes/ghost/vectors/_compact",
        &["", r#"{"field":5}"#, r#"{"field":"embedding"}"#],
    )
    .await;
    falsy_bodies_are_refused(rust.port, &path).await;
    for call in [
        Call::new("GET", "/indexes/ghost/vector-maintenance").authorized(),
        Call::new("POST", "/indexes/ghost/_checkpoint").authorized(),
        Call::new("POST", &format!("/indexes/{INDEX}/_checkpoint")).authorized(),
        Call::new("POST", &format!("/indexes/{INDEX}/_checkpoint")),
    ] {
        let (mine, theirs) = same_error(rust.port, reference.port, &call).await;
        if mine.status == 200 {
            assert_eq!(mine.json(), theirs.json());
        }
    }
    let status_path = format!("/indexes/{INDEX}/vector-maintenance");
    let status = Call::new("GET", &status_path).authorized();
    let mine = send(rust.port, &status).await;
    let theirs = send(reference.port, &status).await;
    assert_eq!((mine.status, theirs.status), (200, 200));
    let entries_of = |reply: &support::Reply| match field(&reply.json(), "fields") {
        Some(Value::Array(entries)) => entries.clone(),
        _ => Vec::new(),
    };
    let (my_fields, their_fields) = (entries_of(&mine), entries_of(&theirs));
    assert_eq!(my_fields.len(), 1, "the index holds one vector field");
    assert_eq!(my_fields.len(), their_fields.len());
    for (my_field, their_field) in my_fields.iter().zip(&their_fields) {
        let (Value::Object(my_field), Value::Object(their_field)) = (my_field, their_field) else {
            panic!("each vector field reports an object");
        };
        let shape = |entry: &narsil::Map| {
            entry
                .iter()
                .map(|(key, value)| (key.clone(), std::mem::discriminant(value)))
                .collect::<Vec<_>>()
        };
        assert_eq!(shape(my_field), shape(their_field));
        assert_eq!(my_field.get("fieldName"), their_field.get("fieldName"));
    }
    reference.stop().await;
    rust.stop().await;
}
