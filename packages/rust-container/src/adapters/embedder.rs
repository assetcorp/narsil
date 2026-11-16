use std::collections::BTreeSet;

use narsil::{
    AdapterError, EmbeddingAdapter, EmbeddingPurpose, ErrorCode, Map, NarsilError, Value,
    write_plain_json,
};

use super::Remote;
use super::constants::{
    ANSWER_OVERHEAD_BYTES, MAX_INPUTS_PER_REQUEST, MAX_JSON_BYTES_PER_EMBEDDING_VALUE,
    MAX_JSON_BYTES_PER_RESULT,
};
use super::retry::{RetryingPost, post_json_with_retry};

const SERVICE: &str = "OpenAI";
const LARGEST_SAFE_INDEX: f64 = 9_007_199_254_740_991.0;

pub struct OpenAiEmbedder {
    remote: Remote,
    dimensions: usize,
}

fn failed(message: String) -> NarsilError {
    NarsilError::new(ErrorCode::EMBEDDING_FAILED, message)
}

fn index_of(item: &Map, count: usize) -> Option<usize> {
    let index = item.get("index")?.as_f64()?;
    let whole = index.fract() == 0.0 && (0.0..=LARGEST_SAFE_INDEX).contains(&index);
    let index = whole.then_some(index as usize)?;
    (index < count).then_some(index)
}

fn embedding_of(item: &Map, dimensions: usize) -> Option<Vec<f32>> {
    let values = item.get("embedding")?.as_array()?;
    if values.len() != dimensions {
        return None;
    }
    values
        .iter()
        .map(|value| {
            let number = value.as_f64()?;
            let single = number as f32;
            (number.is_finite() && single.is_finite()).then_some(single)
        })
        .collect()
}

fn parse_embeddings(
    answer: &Map,
    count: usize,
    dimensions: usize,
) -> Result<Vec<Vec<f32>>, NarsilError> {
    let Some(data) = answer.get("data").and_then(Value::as_array) else {
        return Err(failed(format!("{SERVICE} response missing \"data\" array")));
    };
    if data.len() != count {
        return Err(failed(format!(
            "{SERVICE} returned {} embeddings for {count} inputs",
            data.len()
        )));
    }
    let mut seen = BTreeSet::new();
    let mut placed: Vec<Option<Vec<f32>>> = vec![None; count];
    for (position, item) in data.iter().enumerate() {
        let Some(item) = item.as_object() else {
            return Err(failed(format!(
                "{SERVICE} response item at position {position} is not an object"
            )));
        };
        let Some(index) = index_of(item, count).filter(|index| seen.insert(*index)) else {
            return Err(failed(format!(
                "{SERVICE} response item at position {position} has an invalid or duplicate index"
            )));
        };
        let Some(embedding) = embedding_of(item, dimensions) else {
            return Err(failed(format!(
                "{SERVICE} response item at position {position} has an invalid embedding"
            )));
        };
        placed[index] = Some(embedding);
    }
    Ok(placed.into_iter().flatten().collect())
}

impl OpenAiEmbedder {
    pub fn new(remote: Remote, dimensions: u64) -> OpenAiEmbedder {
        OpenAiEmbedder {
            remote,
            dimensions: usize::try_from(dimensions).unwrap_or(usize::MAX),
        }
    }
}

async fn embed_all(
    remote: Remote,
    inputs: Vec<String>,
    dimensions: usize,
) -> Result<Vec<Vec<f32>>, NarsilError> {
    let mut vectors = Vec::with_capacity(inputs.len());
    for chunk in inputs.chunks(MAX_INPUTS_PER_REQUEST) {
        let mut body = Map::new();
        body.insert(
            "input",
            Value::Array(
                chunk
                    .iter()
                    .map(|text| Value::String(text.clone()))
                    .collect(),
            ),
        );
        body.insert("model", Value::String(remote.model.clone()));
        body.insert("dimensions", Value::Number(dimensions as f64));
        let max_answer_bytes = chunk
            .len()
            .saturating_mul(
                dimensions
                    .saturating_mul(MAX_JSON_BYTES_PER_EMBEDDING_VALUE)
                    .saturating_add(MAX_JSON_BYTES_PER_RESULT),
            )
            .saturating_add(ANSWER_OVERHEAD_BYTES);
        let answer = post_json_with_retry(RetryingPost {
            client: &remote.client,
            url: &remote.url,
            body: write_plain_json(&Value::Object(body)),
            api_key: remote.api_key.as_deref(),
            max_retries: remote.max_retries,
            service: SERVICE,
            failure_code: ErrorCode::EMBEDDING_FAILED,
            max_answer_bytes,
        })
        .await?;
        vectors.extend(parse_embeddings(&answer, chunk.len(), dimensions)?);
    }
    Ok(vectors)
}

impl EmbeddingAdapter for OpenAiEmbedder {
    fn dimensions(&self) -> usize {
        self.dimensions
    }

    fn embed(&self, input: &str, purpose: EmbeddingPurpose) -> Result<Vec<f32>, AdapterError> {
        let mut vectors = self.embed_batch(&[input.to_string()], purpose)?;
        vectors.pop().ok_or_else(|| -> AdapterError {
            Box::new(failed(format!(
                "{SERVICE} returned empty data array for single embedding request"
            )))
        })
    }

    fn embed_batch(
        &self,
        inputs: &[String],
        _purpose: EmbeddingPurpose,
    ) -> Result<Vec<Vec<f32>>, AdapterError> {
        if inputs.is_empty() {
            return Ok(Vec::new());
        }
        let remote = self.remote.clone();
        let work = embed_all(remote, inputs.to_vec(), self.dimensions);
        self.remote
            .wait_for(ErrorCode::EMBEDDING_FAILED, SERVICE, work)
    }
}
