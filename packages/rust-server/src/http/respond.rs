use std::convert::Infallible;
use std::io;

use bytes::Bytes;
use http::header::{CONTENT_TYPE, HeaderName, HeaderValue};
use http::{Response, StatusCode};
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Empty, Full, StreamBody};
use hyper::body::Frame;
use narsil::{Value, write_plain_json};
use tokio::sync::mpsc;
use tokio_stream_shim::ReceiverStream;

use crate::constants::JSON_CONTENT_TYPE;
use crate::errors::{ServerError, server_codes};

pub(crate) type ResponseBody = BoxBody<Bytes, io::Error>;
pub(crate) type HttpResponse = Response<ResponseBody>;

fn infallible(never: Infallible) -> io::Error {
    match never {}
}

pub(crate) fn full_body(bytes: impl Into<Bytes>) -> ResponseBody {
    Full::new(bytes.into()).map_err(infallible).boxed()
}

pub(crate) fn empty_body() -> ResponseBody {
    Empty::new().map_err(infallible).boxed()
}

fn status_of(status: u16) -> StatusCode {
    StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) fn with_body(status: u16, content_type: &str, body: ResponseBody) -> HttpResponse {
    let mut response = Response::new(body);
    *response.status_mut() = status_of(status);
    if let Ok(value) = HeaderValue::from_str(content_type) {
        response.headers_mut().insert(CONTENT_TYPE, value);
    }
    response
}

pub(crate) fn json_text(status: u16, text: String) -> HttpResponse {
    with_body(status, JSON_CONTENT_TYPE, full_body(text))
}

pub(crate) fn json(status: u16, value: &Value) -> HttpResponse {
    json_text(status, write_plain_json(value))
}

pub(crate) fn bytes(status: u16, content_type: &str, data: impl Into<Bytes>) -> HttpResponse {
    with_body(status, content_type, full_body(data))
}

pub(crate) fn empty(status: u16) -> HttpResponse {
    let mut response = Response::new(empty_body());
    *response.status_mut() = status_of(status);
    response
}

pub(crate) fn stream(
    status: u16,
    content_type: &str,
    receiver: mpsc::Receiver<io::Result<Bytes>>,
) -> HttpResponse {
    let frames = ReceiverStream::new(receiver);
    with_body(
        status,
        content_type,
        BodyExt::boxed(StreamBody::new(frames)),
    )
}

pub(crate) fn error(failure: &ServerError) -> HttpResponse {
    let (status, failure) = match StatusCode::from_u16(failure.status) {
        Ok(_) => (failure.status, failure.clone()),
        Err(_) => (
            500,
            ServerError::new(
                500,
                server_codes::HOOK_ERROR,
                "The onRequest hook threw an error",
            ),
        ),
    };
    let mut response = json(status, &failure.envelope());
    for (name, value) in &failure.headers {
        insert_header(&mut response, name, value);
    }
    response
}

pub(crate) fn insert_header(response: &mut HttpResponse, name: &str, value: &str) {
    if let (Ok(name), Ok(value)) = (
        HeaderName::from_bytes(name.as_bytes()),
        HeaderValue::from_str(value),
    ) {
        response.headers_mut().append(name, value);
    }
}

pub(crate) fn frame(chunk: Bytes) -> io::Result<Frame<Bytes>> {
    Ok(Frame::data(chunk))
}

mod tokio_stream_shim {
    use std::io;
    use std::pin::Pin;
    use std::task::{Context, Poll};

    use bytes::Bytes;
    use futures_util::Stream;
    use hyper::body::Frame;
    use tokio::sync::mpsc;

    pub(crate) struct ReceiverStream {
        receiver: mpsc::Receiver<io::Result<Bytes>>,
    }

    impl ReceiverStream {
        pub(crate) fn new(receiver: mpsc::Receiver<io::Result<Bytes>>) -> ReceiverStream {
            ReceiverStream { receiver }
        }
    }

    impl Stream for ReceiverStream {
        type Item = io::Result<Frame<Bytes>>;

        fn poll_next(
            mut self: Pin<&mut Self>,
            context: &mut Context<'_>,
        ) -> Poll<Option<Self::Item>> {
            self.receiver
                .poll_recv(context)
                .map(|chunk| chunk.map(|chunk| chunk.map(Frame::data)))
        }
    }
}
