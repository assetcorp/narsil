use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::Duration;

use crate::engine::adapter_registry::AdapterRegistry;
use crate::engine::vectors::embedding::{AdapterFailure, call_adapter};
use crate::error::{ErrorCode, NarsilError, Result};

fn rerank_failed(message: String) -> NarsilError {
    NarsilError::new(ErrorCode::RERANK_FAILED, message)
}

fn unregistered(name: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::RERANK_CONFIG_INVALID,
        format!(
            "The query gives rerank adapter \"{name}\", which this engine has not registered. Register it with registerRerankAdapter or the rerankAdapters setting"
        ),
    )
}

fn wrapped(failure: AdapterFailure, name: &str) -> NarsilError {
    let message = match failure {
        AdapterFailure::Raised(raised) if raised.code() == ErrorCode::RERANK_FAILED => {
            return raised;
        }
        AdapterFailure::Raised(raised) => raised.message().to_string(),
        AdapterFailure::Failed(message) => message,
    };
    rerank_failed(format!("Rerank adapter \"{name}\" failed: {message}"))
}

fn checked_scores(scores: Vec<f64>, expected: usize, name: &str) -> Result<Vec<f64>> {
    if scores.len() != expected {
        return Err(rerank_failed(format!(
            "Rerank adapter \"{name}\" returned {} scores for {expected} documents",
            scores.len()
        )));
    }
    if let Some(at) = scores.iter().position(|score| !score.is_finite()) {
        return Err(rerank_failed(format!(
            "Rerank adapter \"{name}\" returned a score that is not a finite number at position {at}"
        )));
    }
    Ok(scores)
}

/// Scores `documents` against `query` through the rerank adapter registered under `name`, raising
/// `RERANK_CONFIG_INVALID` where none is registered and `RERANK_FAILED` where the adapter fails, panics, returns
/// unusable scores, or takes longer than the rerank timeout.
///
/// The adapter works on a separate thread with copies of the query and the texts, so that an adapter that blocks
/// holds up only its own query and can reach no index state.
pub(crate) fn score_documents(
    registry: &AdapterRegistry,
    name: &str,
    query: &str,
    documents: Vec<String>,
) -> Result<Vec<f64>> {
    let Some(adapter) = registry.rerank().get(name).cloned() else {
        return Err(unregistered(name));
    };
    if documents.is_empty() {
        return Ok(Vec::new());
    }
    let expected = documents.len();
    let query = query.to_owned();
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::Builder::new()
        .name("narsil-rerank".into())
        .spawn(move || {
            let outcome = call_adapter(|| adapter.score(&query, &documents));
            let _ = sender.send(outcome);
        })
        .map_err(|error| {
            rerank_failed(format!(
                "Rerank adapter \"{name}\" failed: the engine cannot start a thread for it: {error}"
            ))
        })?;
    let timeout_ms = registry.rerank_settings().timeout_ms;
    match receiver.recv_timeout(Duration::from_millis(timeout_ms)) {
        Ok(Ok(scores)) => checked_scores(scores, expected, name),
        Ok(Err(failure)) => Err(wrapped(failure, name)),
        Err(RecvTimeoutError::Timeout) => Err(rerank_failed(format!(
            "Rerank adapter \"{name}\" did not answer within {timeout_ms} ms, so the engine cancelled the call"
        ))),
        Err(RecvTimeoutError::Disconnected) => Err(rerank_failed(format!(
            "Rerank adapter \"{name}\" failed: the adapter stopped without an answer"
        ))),
    }
}
