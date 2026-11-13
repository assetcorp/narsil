use axum::body::{Body, Bytes};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::Response;
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::errors::ApiError;
use crate::json::Object;

const JSON_CONTENT_TYPE: &str = "application/json";
const SERIALIZE_FAILURE_BODY: &str =
    "{\"error\":{\"code\":\"INTERNAL_ERROR\",\"message\":\"The response could not be encoded\"}}";

pub fn json_response<T: Serialize + ?Sized>(status: StatusCode, value: &T) -> Response {
    match serde_json::to_vec(value) {
        Ok(bytes) => with_json_type(status, Body::from(bytes)),
        Err(_) => with_json_type(
            StatusCode::INTERNAL_SERVER_ERROR,
            Body::from(SERIALIZE_FAILURE_BODY),
        ),
    }
}

fn with_json_type(status: StatusCode, body: Body) -> Response {
    let mut response = Response::new(body);
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(JSON_CONTENT_TYPE),
    );
    response
}

pub fn ok<T: Serialize + ?Sized>(value: &T) -> Response {
    json_response(StatusCode::OK, value)
}

pub fn parse_body<T: DeserializeOwned>(body: &Bytes) -> Result<T, ApiError> {
    if body.is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "EMPTY_BODY",
            "Request body is empty",
        ));
    }
    serde_json::from_slice::<Object<T>>(body)
        .map(|value| value.0)
        .map_err(|error| {
            if error.is_syntax() || error.is_eof() {
                ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "INVALID_JSON",
                    "Request body is not valid JSON",
                )
            } else {
                ApiError::invalid(format!("Request body does not match the route: {error}"))
            }
        })
}

pub fn parse_optional_body<T: DeserializeOwned + Default>(body: &Bytes) -> Result<T, ApiError> {
    if body.is_empty() {
        return Ok(T::default());
    }
    parse_body(body)
}

pub fn to_engine_value(value: serde_json::Value) -> narsil::Value {
    match value {
        serde_json::Value::Null => narsil::Value::Null,
        serde_json::Value::Bool(flag) => narsil::Value::Bool(flag),
        serde_json::Value::Number(number) => {
            narsil::Value::Number(number.as_f64().unwrap_or(f64::NAN))
        }
        serde_json::Value::String(text) => narsil::Value::String(text),
        serde_json::Value::Array(items) => {
            narsil::Value::Array(items.into_iter().map(to_engine_value).collect())
        }
        serde_json::Value::Object(fields) => narsil::Value::Object(
            fields
                .into_iter()
                .map(|(key, field)| (key, to_engine_value(field)))
                .collect(),
        ),
    }
}
