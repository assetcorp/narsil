mod constants;
mod embedder;
mod reranker;
mod retry;

use std::collections::BTreeMap;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use narsil::{AdapterError, EmbeddingAdapter, ErrorCode, NarsilError, RerankAdapter};
use tokio::runtime::Handle;

use crate::outbound::OutboundClient;
use crate::settings::types::{EmbedderSetting, RemoteEndpoint, RerankerSetting};
use embedder::OpenAiEmbedder;
use reranker::HttpReranker;

#[derive(Clone)]
pub struct Remote {
    runtime: Handle,
    client: OutboundClient,
    url: String,
    model: String,
    api_key: Option<String>,
    timeout: Duration,
    max_retries: u64,
}

impl Remote {
    fn of(
        runtime: &Handle,
        client: &OutboundClient,
        endpoint: &RemoteEndpoint,
        path: &str,
    ) -> Remote {
        Remote {
            runtime: runtime.clone(),
            client: client.clone(),
            url: format!("{}/{path}", endpoint.url.trim_end_matches('/')),
            model: endpoint.model.clone(),
            api_key: endpoint.api_key.clone(),
            timeout: Duration::from_millis(endpoint.timeout_ms),
            max_retries: endpoint.max_retries,
        }
    }

    fn wait_for<T: Send + 'static>(
        &self,
        code: ErrorCode,
        service: &str,
        work: impl Future<Output = Result<T, NarsilError>> + Send + 'static,
    ) -> Result<T, AdapterError> {
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        let timeout = self.timeout;
        self.runtime.spawn(async move {
            let _ = sender.send(tokio::time::timeout(timeout, work).await);
        });
        let failure = match receiver.recv() {
            Ok(Ok(Ok(found))) => return Ok(found),
            Ok(Ok(Err(failure))) => failure,
            Ok(Err(_)) => NarsilError::new(
                code,
                format!(
                    "{service} did not answer within {} ms",
                    self.timeout.as_millis()
                ),
            ),
            Err(_) => NarsilError::new(
                code,
                format!("{service} stopped because the node is shutting down"),
            ),
        };
        Err(Box::new(failure))
    }
}

pub struct BuiltAdapters {
    pub embedding: BTreeMap<String, Arc<dyn EmbeddingAdapter>>,
    pub rerank: BTreeMap<String, Arc<dyn RerankAdapter>>,
}

pub fn build_adapters(
    runtime: &Handle,
    client: &OutboundClient,
    embedders: &[EmbedderSetting],
    rerankers: &[RerankerSetting],
) -> BuiltAdapters {
    let mut embedding: BTreeMap<String, Arc<dyn EmbeddingAdapter>> = BTreeMap::new();
    for setting in embedders {
        let remote = Remote::of(runtime, client, &setting.endpoint, "embeddings");
        embedding.insert(
            setting.name.clone(),
            Arc::new(OpenAiEmbedder::new(remote, setting.dimensions)),
        );
    }
    let mut rerank: BTreeMap<String, Arc<dyn RerankAdapter>> = BTreeMap::new();
    for setting in rerankers {
        let remote = Remote::of(runtime, client, &setting.endpoint, "rerank");
        rerank.insert(
            setting.name.clone(),
            Arc::new(HttpReranker::new(remote, setting.max_documents_per_request)),
        );
    }
    BuiltAdapters { embedding, rerank }
}
