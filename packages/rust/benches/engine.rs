use std::sync::LazyLock;

use narsil::{DocumentProjection, IndexConfig, Map, Narsil, QueryParams, Value, VectorQuery};

const WITH_VECTORS: DocumentProjection = DocumentProjection::Fields {
    include: None,
    exclude: None,
    vectors: Some(true),
};

const TEXT_INDEX: &str = "articles";
const VECTOR_INDEX: &str = "articles-with-embeddings";
const DOCUMENT_COUNT: usize = 2_000;
const EMBEDDING_DIMENSIONS: usize = 1_536;
const WORDS_PER_TITLE: usize = 6;
const WORDS_PER_BODY: usize = 40;
const PAGE_LIMIT: usize = 10;
const MULTI_GET_COUNT: usize = 20;
const INSERT_BATCH_SIZE: usize = 100;
const READ_ID_STRIDE: usize = 97;
const SEARCH_TERM: &str = "harbour lantern";
const VOCABULARY: [&str; 24] = [
    "harbour", "lantern", "granite", "orchard", "meridian", "copper", "tide", "willow", "signal",
    "quarry", "beacon", "thistle", "ember", "cobalt", "saddle", "river", "falcon", "marble",
    "juniper", "anchor", "ledger", "summit", "harvest", "compass",
];

struct Words(u64);

impl Words {
    fn next(&mut self) -> usize {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        (self.0 >> 33) as usize
    }

    fn sentence(&mut self, words: usize) -> String {
        (0..words)
            .map(|_| VOCABULARY[self.next() % VOCABULARY.len()])
            .collect::<Vec<_>>()
            .join(" ")
    }

    fn embedding(&mut self) -> Value {
        Value::Array(
            (0..EMBEDDING_DIMENSIONS)
                .map(|_| Value::Number((self.next() % 2_000) as f64 / 1_000.0 - 1.0))
                .collect(),
        )
    }
}

fn schema(with_embedding: bool) -> Value {
    let mut schema = Map::new();
    schema.insert("title", Value::String("string".to_string()));
    schema.insert("body", Value::String("string".to_string()));
    schema.insert("rank", Value::String("number".to_string()));
    if with_embedding {
        schema.insert(
            "embedding",
            Value::String(format!("vector[{EMBEDDING_DIMENSIONS}]")),
        );
    }
    Value::Object(schema)
}

fn document_id(row: usize) -> String {
    format!("article-{row:05}")
}

fn documents(seed: u64, first_row: usize, count: usize, with_embedding: bool) -> Vec<Map> {
    let mut words = Words(seed);
    (first_row..first_row + count)
        .map(|row| {
            let mut document = Map::new();
            document.insert("id", Value::String(document_id(row)));
            document.insert("title", Value::String(words.sentence(WORDS_PER_TITLE)));
            document.insert("body", Value::String(words.sentence(WORDS_PER_BODY)));
            document.insert("rank", Value::Number((row % 1_000) as f64));
            if with_embedding {
                document.insert("embedding", words.embedding());
            }
            document
        })
        .collect()
}

fn index_config(with_embedding: bool) -> IndexConfig {
    IndexConfig {
        schema: schema(with_embedding),
        ..IndexConfig::default()
    }
}

fn loaded_engine() -> Narsil {
    let engine = Narsil::new();
    for (name, with_embedding) in [(TEXT_INDEX, false), (VECTOR_INDEX, true)] {
        engine
            .create_index(name, index_config(with_embedding))
            .expect("the benchmark index is created");
        let result = engine
            .insert_batch(
                name,
                documents(0x2545_F491_4F6C_DD1D, 0, DOCUMENT_COUNT, with_embedding),
            )
            .expect("the benchmark documents are inserted");
        assert!(result.failed.is_empty(), "{:?}", result.failed);
    }
    engine
}

static ENGINE: LazyLock<Narsil> = LazyLock::new(loaded_engine);

static QUERY_VECTOR: LazyLock<Vec<f32>> = LazyLock::new(|| {
    let mut words = Words(0x9E37_79B9_7F4A_7C15);
    (0..EMBEDDING_DIMENSIONS)
        .map(|_| (words.next() % 2_000) as f32 / 1_000.0 - 1.0)
        .collect()
});

fn text_query() -> QueryParams {
    QueryParams {
        term: Some(SEARCH_TERM.to_string()),
        limit: Some(PAGE_LIMIT),
        ..QueryParams::default()
    }
}

fn read_ids() -> Vec<String> {
    (0..MULTI_GET_COUNT)
        .map(|step| document_id((step * READ_ID_STRIDE) % DOCUMENT_COUNT))
        .collect()
}

fn searched(index: &str, params: &QueryParams) -> usize {
    let result = ENGINE.query(index, params).expect("the query answers");
    assert_eq!(result.hits.len(), PAGE_LIMIT);
    result.hits.len()
}

#[divan::bench]
fn search_text_index(bencher: divan::Bencher) {
    let params = text_query();
    bencher.bench(|| searched(TEXT_INDEX, divan::black_box(&params)));
}

#[divan::bench]
fn search_text_in_vector_index(bencher: divan::Bencher) {
    let params = text_query();
    bencher.bench(|| searched(VECTOR_INDEX, divan::black_box(&params)));
}

#[divan::bench]
fn search_vector_index_by_vector(bencher: divan::Bencher) {
    let params = QueryParams {
        vector: Some(VectorQuery {
            field: "embedding".to_string(),
            value: Some(QUERY_VECTOR.clone()),
            ..VectorQuery::default()
        }),
        limit: Some(PAGE_LIMIT),
        ..QueryParams::default()
    };
    bencher.bench(|| searched(VECTOR_INDEX, divan::black_box(&params)));
}

#[divan::bench]
fn search_text_in_vector_index_with_vectors(bencher: divan::Bencher) {
    let params = QueryParams {
        document: Some(WITH_VECTORS),
        ..text_query()
    };
    bencher.bench(|| searched(VECTOR_INDEX, divan::black_box(&params)));
}

#[divan::bench]
fn search_vector_index_by_vector_with_vectors(bencher: divan::Bencher) {
    let params = QueryParams {
        vector: Some(VectorQuery {
            field: "embedding".to_string(),
            value: Some(QUERY_VECTOR.clone()),
            ..VectorQuery::default()
        }),
        limit: Some(PAGE_LIMIT),
        document: Some(WITH_VECTORS),
        ..QueryParams::default()
    };
    bencher.bench(|| searched(VECTOR_INDEX, divan::black_box(&params)));
}

fn got(index: &str, id: &str) -> Map {
    ENGINE
        .get(index, id)
        .expect("the read answers")
        .expect("the document is stored")
}

#[divan::bench]
fn get_from_text_index(bencher: divan::Bencher) {
    let id = document_id(DOCUMENT_COUNT / 2);
    bencher.bench(|| got(TEXT_INDEX, divan::black_box(&id)));
}

#[divan::bench]
fn get_from_vector_index(bencher: divan::Bencher) {
    let id = document_id(DOCUMENT_COUNT / 2);
    bencher.bench(|| got(VECTOR_INDEX, divan::black_box(&id)));
}

fn got_many(index: &str, ids: &[String]) -> usize {
    let found = ENGINE.get_multiple(index, ids).expect("the read answers");
    assert_eq!(found.len(), ids.len());
    found.len()
}

#[divan::bench]
fn get_multiple_from_text_index(bencher: divan::Bencher) {
    let ids = read_ids();
    bencher.bench(|| got_many(TEXT_INDEX, divan::black_box(&ids)));
}

#[divan::bench]
fn get_multiple_from_vector_index(bencher: divan::Bencher) {
    let ids = read_ids();
    bencher.bench(|| got_many(VECTOR_INDEX, divan::black_box(&ids)));
}

#[divan::bench]
fn get_from_vector_index_with_vectors(bencher: divan::Bencher) {
    let id = document_id(DOCUMENT_COUNT / 2);
    bencher.bench(|| {
        ENGINE
            .get_with(VECTOR_INDEX, divan::black_box(&id), Some(&WITH_VECTORS))
            .expect("the read answers")
            .expect("the document is stored")
    });
}

#[divan::bench]
fn get_multiple_from_vector_index_with_vectors(bencher: divan::Bencher) {
    let ids = read_ids();
    bencher.bench(|| {
        let found = ENGINE
            .get_multiple_with(VECTOR_INDEX, divan::black_box(&ids), Some(&WITH_VECTORS))
            .expect("the read answers");
        assert_eq!(found.len(), ids.len());
        found.len()
    });
}

fn empty_index(name: &str, with_embedding: bool) -> Narsil {
    let engine = Narsil::new();
    engine
        .create_index(name, index_config(with_embedding))
        .expect("the benchmark index is created");
    engine
}

fn inserted(engine: Narsil, name: &str, batch: Vec<Map>) -> Narsil {
    let result = engine
        .insert_batch(name, batch)
        .expect("the batch is inserted");
    assert!(result.failed.is_empty(), "{:?}", result.failed);
    engine
}

#[divan::bench]
fn insert_batch_into_text_index(bencher: divan::Bencher) {
    bencher
        .with_inputs(|| {
            (
                empty_index(TEXT_INDEX, false),
                documents(0x51_7CC1_B727_220A, 0, INSERT_BATCH_SIZE, false),
            )
        })
        .bench_values(|(engine, batch)| inserted(engine, TEXT_INDEX, batch));
}

#[divan::bench]
fn insert_batch_into_vector_index(bencher: divan::Bencher) {
    bencher
        .with_inputs(|| {
            (
                empty_index(VECTOR_INDEX, true),
                documents(0x51_7CC1_B727_220A, 0, INSERT_BATCH_SIZE, true),
            )
        })
        .bench_values(|(engine, batch)| inserted(engine, VECTOR_INDEX, batch));
}

fn main() {
    LazyLock::force(&ENGINE);
    divan::main();
}
