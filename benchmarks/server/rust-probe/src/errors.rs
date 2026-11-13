use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use narsil::NarsilError;
use serde::Serialize;

use crate::respond::json_response;

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: String,
    pub message: String,
}

#[derive(Serialize)]
struct ErrorBody<'a> {
    code: &'a str,
    message: &'a str,
}

#[derive(Serialize)]
struct ErrorEnvelope<'a> {
    error: ErrorBody<'a>,
}

impl ApiError {
    pub fn new(status: StatusCode, code: &str, message: impl Into<String>) -> ApiError {
        ApiError {
            status,
            code: code.to_owned(),
            message: message.into(),
        }
    }

    pub fn invalid(message: impl Into<String>) -> ApiError {
        ApiError::new(StatusCode::BAD_REQUEST, "INVALID_REQUEST", message)
    }

    pub fn internal(message: impl Into<String>) -> ApiError {
        ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", message)
    }
}

pub fn status_for_code(code: &str) -> StatusCode {
    let status = match code {
        "INVALID_REQUEST"
        | "INVALID_JSON"
        | "EMPTY_BODY"
        | "ENVELOPE_INVALID_MAGIC"
        | "ENVELOPE_VERSION_MISMATCH"
        | "SCHEMA_INVALID_TYPE"
        | "SCHEMA_DEPTH_EXCEEDED"
        | "SCHEMA_INVALID_VECTOR_DIMENSION"
        | "SCHEMA_INVALID_GEOPOINT"
        | "DOC_VALIDATION_FAILED"
        | "DOC_MISSING_REQUIRED_FIELD"
        | "SEARCH_INVALID_FIELD"
        | "VECTOR_DIMENSION_MISMATCH"
        | "SEARCH_INVALID_FILTER"
        | "SEARCH_INVALID_MODE"
        | "SEARCH_INVALID_CURSOR"
        | "SEARCH_RESULT_WINDOW_EXCEEDED"
        | "SEARCH_WORK_CAP_EXCEEDED"
        | "SEARCH_INVALID_PHRASE"
        | "LANGUAGE_NOT_SUPPORTED"
        | "CONFIG_INVALID"
        | "EMBEDDING_DIMENSION_MISMATCH"
        | "EMBEDDING_NO_SOURCE"
        | "EMBEDDING_CONFIG_INVALID"
        | "RERANK_CONFIG_INVALID" => 400,
        "NOT_FOUND" | "TASK_NOT_FOUND" | "INDEX_NOT_FOUND" | "DOC_NOT_FOUND" => 404,
        "PAYLOAD_TOO_LARGE" => 413,
        "INDEX_ALREADY_EXISTS"
        | "INDEX_ORPHANED"
        | "DOC_ALREADY_EXISTS"
        | "PARTITION_REBALANCING_BACKPRESSURE"
        | "PARTITION_CAPACITY_EXCEEDED"
        | "ANALYSIS_CHANGE_REPLACED"
        | "TASK_NOT_CANCELLABLE" => 409,
        "TOO_MANY_REQUESTS" | "MEMORY_WRITE_BLOCKED" | "WORKER_BUSY" => 429,
        "RESTORE_MEMORY_EXCEEDED" | "ANALYSIS_REBUILD_MEMORY_EXCEEDED" => 507,
        "SEARCH_PHRASE_NOT_READY"
        | "INDEX_REOPEN_CAPACITY_EXHAUSTED"
        | "INSTANCE_SHUT_DOWN"
        | "ANALYSIS_CHANGE_NOT_READY"
        | "ANALYSIS_GENERATION_MISSING"
        | "PARTITION_CORRUPTED"
        | "PERSISTENCE_SAVE_FAILED"
        | "PERSISTENCE_LOAD_FAILED"
        | "PERSISTENCE_DELETE_FAILED"
        | "PERSISTENCE_CRC_MISMATCH"
        | "PERSISTENCE_WAL_CORRUPT"
        | "PERSISTENCE_FSYNC_FAILED"
        | "EMBEDDING_FAILED"
        | "RERANK_FAILED"
        | "BM25_NOT_READY"
        | "TASK_INTERRUPTED" => 503,
        _ => 500,
    };
    StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
}

impl From<NarsilError> for ApiError {
    fn from(error: NarsilError) -> ApiError {
        let code = error.code().as_str();
        ApiError::new(status_for_code(code), code, error.message())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let envelope = ErrorEnvelope {
            error: ErrorBody {
                code: &self.code,
                message: &self.message,
            },
        };
        json_response(self.status, &envelope)
    }
}
