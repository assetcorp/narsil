mod constants;

use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use http::{HeaderMap, HeaderName, HeaderValue, Method, Request, Uri};
use http_body_util::{BodyExt, Full, Limited};
use hyper_rustls::{HttpsConnector, HttpsConnectorBuilder};
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;
use rustls::{ClientConfig, RootCertStore};

use constants::{MAX_IDLE_CONNECTIONS_PER_HOST, POOL_IDLE_TIMEOUT_MS};

pub struct Answer {
    pub status: u16,
    pub headers: HeaderMap,
    pub body: Option<Bytes>,
}

#[derive(Clone)]
pub struct OutboundClient {
    client: Arc<Client<HttpsConnector<HttpConnector>, Full<Bytes>>>,
}

#[derive(Debug)]
pub enum SendFailure {
    Request(String),
    Transport(String),
}

impl std::fmt::Display for SendFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SendFailure::Request(message) | SendFailure::Transport(message) => {
                formatter.write_str(message)
            }
        }
    }
}

fn tls_config() -> Result<ClientConfig, String> {
    let roots = RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|failure| format!("The TLS settings are not usable: {failure}"))?
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(config)
}

impl OutboundClient {
    pub fn new() -> Result<OutboundClient, String> {
        let connector = HttpsConnectorBuilder::new()
            .with_tls_config(tls_config()?)
            .https_or_http()
            .enable_http1()
            .build();
        let client = Client::builder(TokioExecutor::new())
            .pool_idle_timeout(Duration::from_millis(POOL_IDLE_TIMEOUT_MS))
            .pool_max_idle_per_host(MAX_IDLE_CONNECTIONS_PER_HOST)
            .build(connector);
        Ok(OutboundClient {
            client: Arc::new(client),
        })
    }

    pub async fn post(
        &self,
        url: &str,
        headers: Vec<(HeaderName, HeaderValue)>,
        body: Bytes,
        max_answer_bytes: usize,
    ) -> Result<Answer, SendFailure> {
        let uri =
            Uri::try_from(url).map_err(|failure| SendFailure::Request(failure.to_string()))?;
        let mut request = Request::builder().method(Method::POST).uri(uri);
        for (name, value) in headers {
            request = request.header(name, value);
        }
        let request = request
            .body(Full::new(body))
            .map_err(|failure| SendFailure::Request(failure.to_string()))?;
        let response = self
            .client
            .request(request)
            .await
            .map_err(|failure| SendFailure::Transport(failure.to_string()))?;
        let (parts, incoming) = response.into_parts();
        if max_answer_bytes == 0 {
            return Ok(Answer {
                status: parts.status.as_u16(),
                headers: parts.headers,
                body: None,
            });
        }
        let body = match Limited::new(incoming, max_answer_bytes).collect().await {
            Ok(collected) => Some(collected.to_bytes()),
            Err(failure)
                if failure
                    .downcast_ref::<http_body_util::LengthLimitError>()
                    .is_some() =>
            {
                None
            }
            Err(failure) => return Err(SendFailure::Transport(failure.to_string())),
        };
        Ok(Answer {
            status: parts.status.as_u16(),
            headers: parts.headers,
            body,
        })
    }
}
