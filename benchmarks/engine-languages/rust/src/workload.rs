use std::fs;
use std::path::Path;

use narsil::{Map, Value, parse_json};

pub const MANIFEST_FILE: &str = "manifest.json";
pub const KEYWORD_DOCUMENTS_FILE: &str = "keyword-documents.jsonl";
pub const KEYWORD_QUERIES_FILE: &str = "keyword-queries.jsonl";
pub const VECTOR_DOCUMENTS_FILE: &str = "vector-documents.jsonl";
pub const VECTOR_DOCUMENT_VECTORS_FILE: &str = "vector-documents.f32";
pub const VECTOR_QUERIES_FILE: &str = "vector-queries.jsonl";
pub const VECTOR_QUERY_VECTORS_FILE: &str = "vector-queries.f32";

const FLOAT32_BYTES: usize = 4;
const LARGEST_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

pub struct Settings {
    pub language: String,
    pub limit: usize,
    pub recall_depth: usize,
    pub hybrid_leg_depth: usize,
    pub ef_search: u32,
    pub hnsw_m: u32,
    pub hnsw_ef_construction: u32,
    pub vector_threshold: u64,
    pub rrf_k: f64,
    pub insert_batch: usize,
    pub warmup_passes: usize,
    pub keyword_passes: usize,
    pub vector_passes: usize,
    pub hybrid_passes: usize,
}

pub struct Manifest {
    pub dimension: usize,
    pub vector_documents: usize,
    pub vector_queries: usize,
    pub settings: Settings,
}

pub struct TextDocument {
    pub id: String,
    pub title: String,
    pub body: String,
}

fn field<'a>(value: &'a Value, path: &str) -> Result<&'a Value, String> {
    value
        .pointer(path)
        .ok_or_else(|| format!("the manifest lacks {path}"))
}

fn count(value: &Value, path: &str) -> Result<usize, String> {
    let number = field(value, path)?
        .as_f64()
        .ok_or_else(|| format!("the manifest's {path} is not a number"))?;
    if number < 1.0 || number.fract() != 0.0 || number > LARGEST_SAFE_INTEGER {
        return Err(format!(
            "the manifest's {path} is not a positive whole number"
        ));
    }
    Ok(number as usize)
}

fn small(value: &Value, path: &str) -> Result<u32, String> {
    u32::try_from(count(value, path)?)
        .map_err(|_| format!("the manifest's {path} does not fit 32 bits"))
}

fn text(value: &Value, path: &str) -> Result<String, String> {
    field(value, path)?
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| format!("the manifest's {path} is not a string"))
}

pub fn read_manifest(directory: &Path) -> Result<Manifest, String> {
    let path = directory.join(MANIFEST_FILE);
    let raw = fs::read_to_string(&path).map_err(|error| format!("{}: {error}", path.display()))?;
    let value = parse_json(&raw).map_err(|error| format!("{}: {error}", path.display()))?;
    Ok(Manifest {
        dimension: count(&value, "vector.dimension")?,
        vector_documents: count(&value, "vector.documents")?,
        vector_queries: count(&value, "vector.queries")?,
        settings: Settings {
            language: text(&value, "settings.language")?,
            limit: count(&value, "settings.limit")?,
            recall_depth: count(&value, "settings.recallDepth")?,
            hybrid_leg_depth: count(&value, "settings.hybridLegDepth")?,
            ef_search: small(&value, "settings.efSearch")?,
            hnsw_m: small(&value, "settings.hnswM")?,
            hnsw_ef_construction: small(&value, "settings.hnswEfConstruction")?,
            vector_threshold: count(&value, "settings.vectorThreshold")? as u64,
            rrf_k: count(&value, "settings.rrfK")? as f64,
            insert_batch: count(&value, "settings.insertBatch")?,
            warmup_passes: count(&value, "settings.warmupPasses")?,
            keyword_passes: count(&value, "settings.measuredPasses.keyword")?,
            vector_passes: count(&value, "settings.measuredPasses.vector")?,
            hybrid_passes: count(&value, "settings.measuredPasses.hybrid")?,
        },
    })
}

fn json_lines(path: &Path) -> Result<Vec<Value>, String> {
    let raw = fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
    raw.lines()
        .filter(|line| !line.is_empty())
        .map(|line| parse_json(line).map_err(|error| format!("{}: {error}", path.display())))
        .collect()
}

fn string_field(row: &Value, name: &str, path: &Path) -> Result<String, String> {
    row.as_object()
        .and_then(|object| object.get(name))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("{}: every line needs a string {name}", path.display()))
}

pub fn read_text_documents(path: &Path) -> Result<Vec<TextDocument>, String> {
    json_lines(path)?
        .iter()
        .map(|row| {
            Ok(TextDocument {
                id: string_field(row, "id", path)?,
                title: string_field(row, "title", path)?,
                body: string_field(row, "body", path)?,
            })
        })
        .collect()
}

pub fn read_query_texts(path: &Path) -> Result<Vec<String>, String> {
    json_lines(path)?
        .iter()
        .map(|row| string_field(row, "text", path))
        .collect()
}

pub fn read_vectors(path: &Path, rows: usize, dimension: usize) -> Result<Vec<Vec<f32>>, String> {
    let raw = fs::read(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let expected = rows * dimension * FLOAT32_BYTES;
    if raw.len() != expected {
        return Err(format!(
            "{} holds {} bytes, while {rows} vectors of {dimension} take {expected}",
            path.display(),
            raw.len()
        ));
    }
    Ok(raw
        .chunks_exact(dimension * FLOAT32_BYTES)
        .map(|row| {
            row.as_chunks::<FLOAT32_BYTES>()
                .0
                .iter()
                .map(|bytes| f32::from_le_bytes(*bytes))
                .collect()
        })
        .collect())
}

pub fn text_document(document: TextDocument) -> Map {
    let mut map = Map::with_capacity(3);
    map.insert("id", Value::String(document.id));
    map.insert("title", Value::String(document.title));
    map.insert("body", Value::String(document.body));
    map
}
