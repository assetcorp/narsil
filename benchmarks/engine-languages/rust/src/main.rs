mod measure;
mod output;
mod workload;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Mutex;
use std::time::Instant;

use narsil::{
    HnswSettings, HybridConfig, HybridStrategy, IndexConfig, Map, Metric, Narsil, NarsilConfig,
    Quantization, QueryParams, QueryResult, SearchMode, Value, VectorPromotion, VectorQuery,
    WorkerConfig, parse_json, write_json,
};

use measure::{
    MeasuredPhase, VerifiedAnswer, elapsed_ns, hold_for_memory_reading, in_parallel, measure_phase,
    verify_each,
};
use output::{LoadTimes, runner_output};
use workload::{
    KEYWORD_DOCUMENTS_FILE, KEYWORD_QUERIES_FILE, Manifest, VECTOR_DOCUMENT_VECTORS_FILE,
    VECTOR_DOCUMENTS_FILE, VECTOR_QUERIES_FILE, VECTOR_QUERY_VECTORS_FILE, read_manifest,
    read_query_texts, read_text_documents, read_vectors, text_document,
};

const INDEX: &str = "bench";
const VECTOR_FIELD: &str = "embedding";
const MAX_THREADS: usize = 31;
const USAGE: &str =
    "usage: narsil-engine-languages-runner <workload-dir> <keyword|vector> <threads> <output-file>";

type Verification = Vec<(&'static str, Vec<VerifiedAnswer>)>;
type Phases = Vec<(&'static str, MeasuredPhase)>;

struct Arguments {
    workload: PathBuf,
    kind: String,
    threads: usize,
    output: PathBuf,
}

fn parse_arguments() -> Result<Arguments, String> {
    let values: Vec<String> = std::env::args().skip(1).collect();
    let [workload, kind, threads, output] = values.as_slice() else {
        return Err(USAGE.to_string());
    };
    if kind != "keyword" && kind != "vector" {
        return Err(USAGE.to_string());
    }
    let threads: usize = threads
        .parse()
        .map_err(|_| "threads must be a whole number of at least 1".to_string())?;
    if threads == 0 || threads > MAX_THREADS {
        return Err(format!(
            "threads must be a whole number from 1 to {MAX_THREADS}"
        ));
    }
    Ok(Arguments {
        workload: PathBuf::from(workload),
        kind: kind.clone(),
        threads,
        output: PathBuf::from(output),
    })
}

fn failed(error: narsil::NarsilError) -> String {
    format!("{error:?}")
}

fn open_engine(threads: usize, threshold: u64) -> Result<Narsil, String> {
    let workers = if threads == 1 {
        WorkerConfig {
            enabled: Some(false),
            ..WorkerConfig::default()
        }
    } else {
        WorkerConfig {
            enabled: Some(true),
            count: Some(threads as u64),
            promotion_threshold: Some(threshold),
            ..WorkerConfig::default()
        }
    };
    Narsil::open(NarsilConfig {
        workers: Some(workers),
        ..NarsilConfig::default()
    })
    .map_err(failed)
}

fn create_index(engine: &Narsil, kind: &str, manifest: &Manifest) -> Result<(), String> {
    let settings = &manifest.settings;
    let schema = if kind == "keyword" {
        r#"{"title": "string", "body": "string"}"#.to_string()
    } else {
        format!(
            r#"{{"title": "string", "body": "string", "{VECTOR_FIELD}": "vector[{}]"}}"#,
            manifest.dimension
        )
    };
    let vector_promotion = (kind == "vector").then(|| VectorPromotion {
        threshold: Some(settings.vector_threshold),
        hnsw: Some(HnswSettings {
            m: Some(settings.hnsw_m),
            ef_construction: Some(settings.hnsw_ef_construction),
            metric: Some(Metric::Cosine),
        }),
        quantization: Some(Quantization::None),
        ..VectorPromotion::default()
    });
    let config = IndexConfig {
        schema: parse_json(&schema).map_err(failed)?,
        language: Some(settings.language.clone()),
        vector_promotion,
        ..IndexConfig::default()
    };
    engine.create_index(INDEX, config).map_err(failed)
}

fn vector_value(vector: &[f32]) -> Value {
    Value::Array(
        vector
            .iter()
            .map(|component| Value::Number(f64::from(*component)))
            .collect(),
    )
}

fn documents(directory: &Path, kind: &str, manifest: &Manifest) -> Result<Vec<Map>, String> {
    if kind == "keyword" {
        let rows = read_text_documents(&directory.join(KEYWORD_DOCUMENTS_FILE))?;
        return Ok(rows.into_iter().map(text_document).collect());
    }
    let rows = read_text_documents(&directory.join(VECTOR_DOCUMENTS_FILE))?;
    let vectors = read_vectors(
        &directory.join(VECTOR_DOCUMENT_VECTORS_FILE),
        manifest.vector_documents,
        manifest.dimension,
    )?;
    if rows.len() != vectors.len() {
        return Err(format!(
            "{} documents carry {} vectors",
            rows.len(),
            vectors.len()
        ));
    }
    Ok(rows
        .into_iter()
        .zip(&vectors)
        .map(|(row, vector)| {
            let mut map = text_document(row);
            map.insert(VECTOR_FIELD, vector_value(vector));
            map
        })
        .collect())
}

fn batches_of(documents: Vec<Map>, size: usize) -> Vec<Mutex<Option<Vec<Map>>>> {
    let mut batches = Vec::new();
    let mut rest = documents.into_iter();
    loop {
        let batch: Vec<Map> = rest.by_ref().take(size).collect();
        if batch.is_empty() {
            return batches;
        }
        batches.push(Mutex::new(Some(batch)));
    }
}

fn insert_all(
    engine: &Narsil,
    batches: &[Mutex<Option<Vec<Map>>>],
    threads: usize,
) -> Result<(), String> {
    in_parallel(threads, batches.len(), |item| {
        let batch = batches[item]
            .lock()
            .map_err(|_| "a batch lock was poisoned".to_string())?
            .take()
            .ok_or_else(|| format!("batch {item} was taken twice"))?;
        let result = engine.insert_batch(INDEX, batch).map_err(failed)?;
        match result.failed.first() {
            Some(first) => Err(format!(
                "batch {item} refused {} documents: {:?}",
                result.failed.len(),
                first.error
            )),
            None => Ok(()),
        }
    })
}

fn search(engine: &Narsil, params: &QueryParams) -> Result<QueryResult, String> {
    engine.query(INDEX, params).map_err(failed)
}

fn run_keyword(
    engine: &Narsil,
    directory: &Path,
    manifest: &Manifest,
    threads: usize,
) -> Result<(Verification, Phases), String> {
    let settings = &manifest.settings;
    let params: Vec<QueryParams> = read_query_texts(&directory.join(KEYWORD_QUERIES_FILE))?
        .into_iter()
        .map(|term| QueryParams {
            term: Some(term),
            limit: Some(settings.limit),
            ..QueryParams::default()
        })
        .collect();
    let run = |query: usize| search(engine, &params[query]);
    let keyword = verify_each(params.len(), run)?;
    let phase = measure_phase(
        threads,
        settings.warmup_passes,
        settings.keyword_passes,
        &keyword,
        run,
    )?;
    Ok((vec![("keyword", keyword)], vec![("keyword", phase)]))
}

fn run_vector(
    engine: &Narsil,
    directory: &Path,
    manifest: &Manifest,
    threads: usize,
) -> Result<(Verification, Phases), String> {
    let settings = &manifest.settings;
    let texts = read_query_texts(&directory.join(VECTOR_QUERIES_FILE))?;
    let vectors = read_vectors(
        &directory.join(VECTOR_QUERY_VECTORS_FILE),
        manifest.vector_queries,
        manifest.dimension,
    )?;
    if texts.len() != vectors.len() {
        return Err(format!(
            "{} vector queries carry {} vectors",
            texts.len(),
            vectors.len()
        ));
    }
    let clause = |vector: &Vec<f32>| VectorQuery {
        field: VECTOR_FIELD.to_string(),
        value: Some(vector.clone()),
        metric: Some(Metric::Cosine),
        ef_search: Some(settings.ef_search),
        ..VectorQuery::default()
    };
    let vector_params = |limit: usize| -> Vec<QueryParams> {
        vectors
            .iter()
            .map(|vector| QueryParams {
                mode: Some(SearchMode::Vector),
                vector: Some(clause(vector)),
                limit: Some(limit),
                ..QueryParams::default()
            })
            .collect()
    };
    let top = vector_params(settings.limit);
    let leg = vector_params(settings.hybrid_leg_depth);
    let deep = vector_params(settings.recall_depth);
    let hybrid: Vec<QueryParams> = texts
        .iter()
        .zip(&vectors)
        .map(|(text, vector)| QueryParams {
            mode: Some(SearchMode::Hybrid),
            term: Some(text.clone()),
            vector: Some(clause(vector)),
            hybrid: Some(HybridConfig {
                strategy: Some(HybridStrategy::Rrf),
                k: Some(settings.rrf_k),
                ..HybridConfig::default()
            }),
            limit: Some(settings.limit),
            ..QueryParams::default()
        })
        .collect();
    let text_leg: Vec<QueryParams> = texts
        .iter()
        .map(|text| QueryParams {
            term: Some(text.clone()),
            limit: Some(settings.hybrid_leg_depth),
            ..QueryParams::default()
        })
        .collect();
    let count = texts.len();
    let run_top = |query: usize| search(engine, &top[query]);
    let run_hybrid = |query: usize| search(engine, &hybrid[query]);
    let vector = verify_each(count, run_top)?;
    let vector_leg = verify_each(count, |query| search(engine, &leg[query]))?;
    let vector_deep = verify_each(count, |query| search(engine, &deep[query]))?;
    let text_leg_answers = verify_each(count, |query| search(engine, &text_leg[query]))?;
    let hybrid_answers = verify_each(count, run_hybrid)?;
    let vector_phase = measure_phase(
        threads,
        settings.warmup_passes,
        settings.vector_passes,
        &vector,
        run_top,
    )?;
    let hybrid_phase = measure_phase(
        threads,
        settings.warmup_passes,
        settings.hybrid_passes,
        &hybrid_answers,
        run_hybrid,
    )?;
    Ok((
        vec![
            ("vector", vector),
            ("vectorLeg", vector_leg),
            ("vectorDeep", vector_deep),
            ("textLeg", text_leg_answers),
            ("hybrid", hybrid_answers),
        ],
        vec![("vector", vector_phase), ("hybrid", hybrid_phase)],
    ))
}

fn run() -> Result<(), String> {
    let arguments = parse_arguments()?;
    let manifest = read_manifest(&arguments.workload)?;
    let engine = open_engine(
        arguments.threads,
        manifest.settings.worker_promotion_threshold,
    )?;
    create_index(&engine, &arguments.kind, &manifest)?;

    let loaded = documents(&arguments.workload, &arguments.kind, &manifest)?;
    let document_count = loaded.len();
    let batches = batches_of(loaded, manifest.settings.insert_batch);
    let insert_start = Instant::now();
    insert_all(&engine, &batches, arguments.threads)?;
    let insert_ns = elapsed_ns(insert_start);
    drop(batches);
    let optimize_start = Instant::now();
    if arguments.kind == "vector" {
        engine
            .optimize_vectors(INDEX, Some(VECTOR_FIELD))
            .map_err(failed)?;
    }
    let optimize_ns = elapsed_ns(optimize_start);
    let ready_ns = 0;

    hold_for_memory_reading()?;

    let (verification, phases) = if arguments.kind == "keyword" {
        run_keyword(&engine, &arguments.workload, &manifest, arguments.threads)?
    } else {
        run_vector(&engine, &arguments.workload, &manifest, arguments.threads)?
    };
    let load = LoadTimes {
        documents: document_count,
        insert_ns,
        optimize_ns,
        ready_ns,
    };
    let output = runner_output(
        &arguments.kind,
        arguments.threads,
        &load,
        &verification,
        &phases,
    );
    fs::write(&arguments.output, write_json(&output))
        .map_err(|error| format!("{}: {error}", arguments.output.display()))?;
    engine.shutdown().map_err(failed)
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}
