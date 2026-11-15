mod support;

use std::io::Read;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use bytes::Bytes;
use flate2::read::GzDecoder;
use narsil::{Map, Value};
use narsil_server::ServerOptions;
use support::{
    Call, ReferenceServer, Reply, RustServer, ScratchDirectory, decode_json, object, send,
};

const INDEX: &str = "bills";
const RESTORED_INDEX: &str = "bills-restored";
const INSERT_BATCH_DOCUMENTS: usize = 500;
const DATASET_DOCUMENTS: usize = 10_000;
const VECTOR_DIMENSION: usize = 384;
const FLOAT32_BYTES: usize = 4;
const SCORE_RELATIVE_TOLERANCE: f64 = 1e-9;
const TASK_POLL_INTERVAL: Duration = Duration::from_millis(100);
const TASK_DEADLINE: Duration = Duration::from_secs(300);

type RankedHits = Vec<(String, u64)>;
type Groups = Vec<(Value, Vec<String>)>;

#[derive(Debug, PartialEq)]
struct Answers {
    text: Vec<(String, RankedHits)>,
    grouped: Vec<(String, Groups)>,
    vector: Vec<(String, Vec<String>)>,
}

fn conformance_path(relative: &str) -> PathBuf {
    support::repository_root()
        .join("packages/conformance")
        .join(relative)
}

fn read_dataset_file(relative: &str) -> Vec<u8> {
    let path = conformance_path(relative);
    std::fs::read(&path).unwrap_or_else(|error| {
        panic!(
            "{} is unreadable ({error}); run `node packages/conformance/dist/cli.mjs fetch` first",
            path.display()
        )
    })
}

fn json_file(relative: &str) -> Value {
    let bytes = read_dataset_file(relative);
    decode_json(&String::from_utf8_lossy(&bytes)).expect("the file holds JSON")
}

fn at<'a>(value: &'a Value, path: &str) -> &'a Value {
    value
        .pointer(path)
        .unwrap_or_else(|| panic!("the JSON holds {path}"))
}

fn list<'a>(value: &'a Value, path: &str) -> &'a [Value] {
    at(value, path)
        .as_array()
        .unwrap_or_else(|| panic!("{path} is a list"))
}

fn text<'a>(value: &'a Value, path: &str) -> &'a str {
    at(value, path)
        .as_str()
        .unwrap_or_else(|| panic!("{path} is a string"))
}

fn whole(value: &Value, path: &str) -> usize {
    at(value, path)
        .as_f64()
        .unwrap_or_else(|| panic!("{path} is a number")) as usize
}

fn documents_with_vectors() -> Vec<Value> {
    let mut decompressed = String::new();
    GzDecoder::new(read_dataset_file(".dataset/documents.jsonl.gz").as_slice())
        .read_to_string(&mut decompressed)
        .expect("the documents decompress as UTF-8");
    let vectors = read_dataset_file(".dataset/vectors.f32");
    let (rows, _) = vectors.as_chunks::<{ VECTOR_DIMENSION * FLOAT32_BYTES }>();
    let documents: Vec<Value> = decompressed
        .lines()
        .zip(rows)
        .map(|(line, row)| {
            let Value::Object(mut document) = decode_json(line).expect("each line is JSON") else {
                panic!("each line holds an object");
            };
            let (elements, _) = row.as_chunks::<FLOAT32_BYTES>();
            let vector = elements
                .iter()
                .map(|bytes| Value::Number(f64::from(f32::from_le_bytes(*bytes))))
                .collect();
            document.insert("embedding", Value::Array(vector));
            Value::Object(document)
        })
        .collect();
    assert_eq!(
        documents.len(),
        DATASET_DOCUMENTS,
        "one vector per document"
    );
    documents
}

async fn json_call(port: u16, method: &str, path: &str, body: &Value) -> Reply {
    send(port, &Call::new(method, path).json(body)).await
}

async fn fill(port: u16, searches: &Value) {
    let created = json_call(
        port,
        "POST",
        "/indexes",
        &object(vec![
            ("name", Value::String(INDEX.to_string())),
            ("config", at(searches, "index").clone()),
        ]),
    )
    .await;
    assert_eq!(created.status, 201, "{:?}", created.json());
    let path = format!("/indexes/{INDEX}/documents/_batch");
    for batch in documents_with_vectors().chunks(INSERT_BATCH_DOCUMENTS) {
        let reply = json_call(
            port,
            "POST",
            &path,
            &object(vec![("documents", Value::Array(batch.to_vec()))]),
        )
        .await;
        assert_eq!(reply.status, 200, "{:?}", reply.json());
        assert_eq!(
            reply
                .json()
                .pointer("failed")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(0),
            "every document of the batch is inserted"
        );
    }
}

async fn search(port: u16, index: &str, body: Value) -> Value {
    let reply = json_call(port, "POST", &format!("/indexes/{index}/search"), &body).await;
    assert_eq!(reply.status, 200, "{:?}", reply.json());
    reply.json()
}

fn hit_ids(hits: &[Value]) -> Vec<String> {
    hits.iter().map(|hit| text(hit, "id").to_string()).collect()
}

async fn answers(port: u16, index: &str, searches: &Value, vector_queries: &[Value]) -> Answers {
    let limit = Value::Number(whole(searches, "text.limit") as f64);
    let mut text_answers = Vec::new();
    for query in list(searches, "text.queries") {
        let found = search(
            port,
            index,
            object(vec![
                ("term", at(query, "text").clone()),
                ("limit", limit.clone()),
            ]),
        )
        .await;
        let hits = list(&found, "hits")
            .iter()
            .map(|hit| {
                let score = at(hit, "score").as_f64().expect("each hit has a score");
                (text(hit, "id").to_string(), score.to_bits())
            })
            .collect();
        text_answers.push((text(query, "id").to_string(), hits));
    }
    let mut grouped_answers = Vec::new();
    for query in list(searches, "grouped.queries") {
        let found = search(
            port,
            index,
            object(vec![
                ("term", at(query, "text").clone()),
                ("limit", limit.clone()),
                ("group", at(searches, "grouped.group").clone()),
            ]),
        )
        .await;
        let groups = list(&found, "groups")
            .iter()
            .map(|group| (at(group, "values").clone(), hit_ids(list(group, "hits"))))
            .collect();
        grouped_answers.push((text(query, "id").to_string(), groups));
    }
    let deepest = list(searches, "vector.floors")
        .iter()
        .map(|floor| whole(floor, "k"))
        .max()
        .expect("the searches set a recall floor");
    let mut vector_answers = Vec::new();
    for query in vector_queries {
        let found = search(
            port,
            index,
            object(vec![
                ("mode", Value::String("vector".to_string())),
                (
                    "vector",
                    object(vec![
                        ("field", at(searches, "vector.field").clone()),
                        ("value", at(query, "vector").clone()),
                    ]),
                ),
                ("limit", Value::Number(deepest as f64)),
            ]),
        )
        .await;
        vector_answers.push((text(query, "id").to_string(), hit_ids(list(&found, "hits"))));
    }
    Answers {
        text: text_answers,
        grouped: grouped_answers,
        vector: vector_answers,
    }
}

fn check_against_committed(answers: &Answers, searches: &Value) -> Vec<String> {
    let mut problems = Vec::new();
    for ((id, hits), query) in answers.text.iter().zip(list(searches, "text.queries")) {
        let wanted = list(query, "hits");
        let found_ids: Vec<&str> = hits.iter().map(|(hit, _)| hit.as_str()).collect();
        let wanted_ids: Vec<&str> = wanted.iter().map(|hit| text(hit, "id")).collect();
        if found_ids != wanted_ids {
            problems.push(format!(
                "text {id}: found {found_ids:?}, wanted {wanted_ids:?}"
            ));
            continue;
        }
        for ((hit, bits), wanted_hit) in hits.iter().zip(wanted) {
            let score = f64::from_bits(*bits);
            let wanted_score = at(wanted_hit, "score").as_f64().unwrap_or(f64::NAN);
            if (score - wanted_score).abs() > SCORE_RELATIVE_TOLERANCE * wanted_score.abs().max(1.0)
            {
                problems.push(format!(
                    "text {id}: {hit} scored {score:e}, wanted {wanted_score:e}"
                ));
            }
        }
    }
    for ((id, groups), query) in answers
        .grouped
        .iter()
        .zip(list(searches, "grouped.queries"))
    {
        let wanted: Groups = list(query, "groups")
            .iter()
            .map(|group| {
                let ids = list(group, "ids")
                    .iter()
                    .map(|value| value.as_str().unwrap_or_default().to_string())
                    .collect();
                (at(group, "values").clone(), ids)
            })
            .collect();
        if groups != &wanted {
            problems.push(format!("grouped {id}: found {groups:?}, wanted {wanted:?}"));
        }
    }
    for floor in list(searches, "vector.floors") {
        let k = whole(floor, "k");
        let minimum = at(floor, "floor").as_f64().unwrap_or(1.0);
        let mut found_total = 0usize;
        let mut wanted_total = 0usize;
        for ((id, hits), query) in answers.vector.iter().zip(list(searches, "vector.queries")) {
            assert_eq!(id, text(query, "id"), "the vector queries pair up in order");
            let neighbours: Vec<&str> = list(query, "neighbours")
                .iter()
                .take(k)
                .map(|neighbour| text(neighbour, "id"))
                .collect();
            wanted_total += neighbours.len();
            found_total += hits
                .iter()
                .take(k)
                .filter(|hit| neighbours.contains(&hit.as_str()))
                .count();
        }
        let recall = found_total as f64 / wanted_total.max(1) as f64;
        if recall < minimum {
            problems.push(format!(
                "vector recall@{k} is {recall}, below the floor of {minimum}"
            ));
        }
    }
    problems
}

async fn snapshot_of(port: u16) -> Bytes {
    let reply = send(
        port,
        &Call::new("GET", &format!("/indexes/{INDEX}/snapshot")),
    )
    .await;
    assert_eq!(reply.status, 200, "the snapshot downloads");
    reply.body
}

async fn restore(port: u16, archive: Bytes) {
    let path = format!("/indexes/{RESTORED_INDEX}/restore");
    let started = send(
        port,
        &Call::new("POST", &path)
            .header("content-type", "application/x-tar")
            .raw(archive),
    )
    .await;
    assert_eq!(started.status, 202, "{:?}", started.json());
    let task = text(&started.json(), "id").to_string();
    let deadline = Instant::now() + TASK_DEADLINE;
    loop {
        let record = send(port, &Call::new("GET", &format!("/tasks/{task}")))
            .await
            .json();
        match text(&record, "status") {
            "succeeded" => return,
            "running" if Instant::now() < deadline => tokio::time::sleep(TASK_POLL_INTERVAL).await,
            status => panic!("the restore task ended {status}: {record:?}"),
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn an_index_that_the_rust_server_saves_answers_the_conformance_searches_alike_in_the_typescript_server()
 {
    let searches = json_file("searches/queries.json");
    let dataset_queries = json_file(".dataset/queries.json");
    let vector_queries = list(&dataset_queries, "vectorQueries");
    let directory = ScratchDirectory::new("conformance-parity");

    let writer = RustServer::durable(directory.path(), ServerOptions::default()).await;
    fill(writer.port, &searches).await;
    let checkpoint = send(
        writer.port,
        &Call::new("POST", &format!("/indexes/{INDEX}/_checkpoint")),
    )
    .await;
    assert_eq!(checkpoint.status, 200, "{:?}", checkpoint.json());
    writer.stop().await;

    let reopened = RustServer::durable(directory.path(), ServerOptions::default()).await;
    let counted = send(
        reopened.port,
        &Call::new("GET", &format!("/indexes/{INDEX}/count")),
    )
    .await;
    assert_eq!(
        counted.json().pointer("count").and_then(Value::as_f64),
        Some(DATASET_DOCUMENTS as f64),
        "the restarted server finds every document"
    );
    let rust_answers = answers(reopened.port, INDEX, &searches, vector_queries).await;
    let archive = snapshot_of(reopened.port).await;
    reopened.stop().await;

    let problems = check_against_committed(&rust_answers, &searches);
    assert!(
        problems.is_empty(),
        "against the committed searches:\n{}",
        problems.join("\n")
    );

    let mut spec = Map::new();
    spec.insert(
        "directory",
        Value::String(directory.path().to_string_lossy().into_owned()),
    );
    let reference = ReferenceServer::start(Value::Object(spec)).await;
    let opened = answers(reference.port, INDEX, &searches, vector_queries).await;
    assert_eq!(
        (&opened.text, &opened.grouped),
        (&rust_answers.text, &rust_answers.grouped),
        "the TypeScript server ranks and scores the saved index bit for bit as the Rust server does"
    );
    let problems = check_against_committed(&opened, &searches);
    assert!(
        problems.is_empty(),
        "the TypeScript server on the saved files:\n{}",
        problems.join("\n")
    );

    restore(reference.port, archive).await;
    let restored = answers(reference.port, RESTORED_INDEX, &searches, vector_queries).await;
    assert_eq!(
        (&restored.text, &restored.grouped),
        (&rust_answers.text, &rust_answers.grouped),
        "the TypeScript server ranks and scores the restored snapshot bit for bit as the Rust server does"
    );
    let problems = check_against_committed(&restored, &searches);
    assert!(
        problems.is_empty(),
        "the TypeScript server on the snapshot:\n{}",
        problems.join("\n")
    );
    reference.stop().await;
}
