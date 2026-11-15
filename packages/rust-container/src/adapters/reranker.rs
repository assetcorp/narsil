use narsil::{AdapterError, ErrorCode, Map, NarsilError, RerankAdapter, Value, write_plain_json};

use super::Remote;
use super::constants::{ANSWER_OVERHEAD_BYTES, MAX_JSON_BYTES_PER_RESULT, RERANK_ECHO_FACTOR};
use super::retry::{RetryingPost, post_json_with_retry};

const SERVICE: &str = "Rerank service";
const LARGEST_SAFE_INDEX: f64 = 9_007_199_254_740_991.0;

pub struct HttpReranker {
    remote: Remote,
    per_request: usize,
}

fn failed(message: String) -> NarsilError {
    NarsilError::new(ErrorCode::RERANK_FAILED, format!("{SERVICE} {message}"))
}

fn scores_of(answer: &Map, count: usize) -> Result<Vec<f64>, NarsilError> {
    let Some(results) = answer.get("results").and_then(Value::as_array) else {
        return Err(failed(
            "response is missing a \"results\" array".to_string(),
        ));
    };
    if results.len() != count {
        return Err(failed(format!(
            "returned {} results for {count} documents",
            results.len()
        ))
        .with_details([
            ("expected", Value::Number(count as f64)),
            ("actual", Value::Number(results.len() as f64)),
        ]));
    }
    let mut scores: Vec<Option<f64>> = vec![None; count];
    for (position, item) in results.iter().enumerate() {
        let fields = item.as_object();
        let index = fields
            .and_then(|fields| fields.get("index"))
            .and_then(Value::as_f64)
            .filter(|index| index.fract() == 0.0 && (0.0..=LARGEST_SAFE_INDEX).contains(index))
            .map(|index| index as usize)
            .filter(|index| *index < count && scores[*index].is_none());
        let Some(index) = index else {
            return Err(failed(format!(
                "result at position {position} carries no index of a document it was sent, or repeats one"
            )));
        };
        let score = fields
            .and_then(|fields| fields.get("relevance_score"))
            .and_then(Value::as_f64)
            .filter(|score| score.is_finite());
        let Some(score) = score else {
            return Err(failed(format!(
                "result at position {position} carries no finite \"relevance_score\""
            )));
        };
        scores[index] = Some(score);
    }
    Ok(scores.into_iter().flatten().collect())
}

impl HttpReranker {
    pub fn new(remote: Remote, per_request: u64) -> HttpReranker {
        HttpReranker {
            remote,
            per_request: usize::try_from(per_request).unwrap_or(usize::MAX).max(1),
        }
    }
}

async fn score_all(
    remote: Remote,
    query: String,
    documents: Vec<String>,
    per_request: usize,
) -> Result<Vec<f64>, NarsilError> {
    let mut scores = Vec::with_capacity(documents.len());
    for chunk in documents.chunks(per_request) {
        let mut body = Map::new();
        body.insert("model", Value::String(remote.model.clone()));
        body.insert("query", Value::String(query.clone()));
        body.insert(
            "documents",
            Value::Array(
                chunk
                    .iter()
                    .map(|text| Value::String(text.clone()))
                    .collect(),
            ),
        );
        body.insert("top_n", Value::Number(chunk.len() as f64));
        let body = write_plain_json(&Value::Object(body));
        let max_answer_bytes = body
            .len()
            .saturating_mul(RERANK_ECHO_FACTOR)
            .saturating_add(chunk.len().saturating_mul(MAX_JSON_BYTES_PER_RESULT))
            .saturating_add(ANSWER_OVERHEAD_BYTES);
        let answer = post_json_with_retry(RetryingPost {
            client: &remote.client,
            url: &remote.url,
            body,
            api_key: remote.api_key.as_deref(),
            max_retries: remote.max_retries,
            service: SERVICE,
            failure_code: ErrorCode::RERANK_FAILED,
            max_answer_bytes,
        })
        .await?;
        scores.extend(scores_of(&answer, chunk.len())?);
    }
    Ok(scores)
}

impl RerankAdapter for HttpReranker {
    fn score(&self, query: &str, documents: &[String]) -> Result<Vec<f64>, AdapterError> {
        if documents.is_empty() {
            return Ok(Vec::new());
        }
        let work = score_all(
            self.remote.clone(),
            query.to_string(),
            documents.to_vec(),
            self.per_request,
        );
        self.remote
            .wait_for(ErrorCode::RERANK_FAILED, SERVICE, work)
    }
}
