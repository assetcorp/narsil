use std::future::Future;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use http::Uri;
use hyper::body::Incoming;
use hyper::client::conn::http2::SendRequest;
use hyper_util::rt::{TokioIo, TokioTimer};
use narsil::Value;
use tokio::task::JoinSet;
use tokio::time::Instant;
use tokio_rustls::rustls::ClientConfig;

use crate::constants::{GRPC_KEEPALIVE_TIME_MS, GRPC_KEEPALIVE_TIMEOUT_MS};
use crate::controller::lock;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::transport::BoxFuture;
use crate::transport::io::connect;
use crate::transport::peers::PeerLink;

type Body = tonic::body::Body;

pub(super) fn connect_failed(target: &str, reason: String) -> ClusterError {
    ClusterError::new(
        codes::TRANSPORT_CONNECT_FAILED,
        format!("Failed to connect to '{target}': {reason}"),
    )
    .with_detail("target", Value::String(target.to_string()))
}

#[derive(Clone)]
pub(super) struct Http2Channel(SendRequest<Body>);

impl tower_service::Service<http::Request<Body>> for Http2Channel {
    type Response = http::Response<Incoming>;
    type Error = hyper::Error;
    type Future = BoxFuture<'static, Result<http::Response<Incoming>, hyper::Error>>;

    fn poll_ready(&mut self, context: &mut Context<'_>) -> Poll<Result<(), hyper::Error>> {
        self.0.poll_ready(context)
    }

    fn call(&mut self, request: http::Request<Body>) -> Self::Future {
        Box::pin(self.0.send_request(request))
    }
}

#[derive(Default)]
struct Running {
    stopped: bool,
    tasks: JoinSet<()>,
}

#[derive(Clone, Default)]
struct ConnectionTasks(Arc<Mutex<Running>>);

impl<F> hyper::rt::Executor<F> for ConnectionTasks
where
    F: Future + Send + 'static,
{
    fn execute(&self, future: F) {
        let mut running = lock(&self.0);
        if running.stopped {
            return;
        }
        while running.tasks.try_join_next().is_some() {}
        running.tasks.spawn(async move {
            let _ = future.await;
        });
    }
}

impl ConnectionTasks {
    fn is_finished(&self) -> bool {
        let mut running = lock(&self.0);
        while running.tasks.try_join_next().is_some() {}
        running.tasks.is_empty()
    }

    fn stop(&self) {
        let mut running = lock(&self.0);
        running.stopped = true;
        running.tasks.abort_all();
    }

    async fn stopped(&self) {
        let mut tasks = std::mem::take(&mut lock(&self.0).tasks);
        while tasks.join_next().await.is_some() {}
    }
}

#[derive(Clone)]
pub(super) struct PeerChannel {
    pub(super) channel: Http2Channel,
    pub(super) origin: Uri,
    tasks: ConnectionTasks,
}

impl PeerChannel {
    pub(super) async fn open(
        target: String,
        tls: Option<Arc<ClientConfig>>,
        timeout: Duration,
    ) -> ClusterResult<PeerChannel> {
        let scheme = if tls.is_some() { "https" } else { "http" };
        let origin = Uri::try_from(format!("{scheme}://{target}")).map_err(|_| {
            connect_failed(&target, "the address is not a host and port".to_string())
                .with_detail("unaddressableTarget", Value::Bool(true))
        })?;
        let started = Instant::now();
        let stream = connect(&target, tls, timeout).await?;
        let tasks = ConnectionTasks::default();
        let mut builder = hyper::client::conn::http2::Builder::new(tasks.clone());
        builder
            .timer(TokioTimer::new())
            .keep_alive_interval(Duration::from_millis(GRPC_KEEPALIVE_TIME_MS))
            .keep_alive_timeout(Duration::from_millis(GRPC_KEEPALIVE_TIMEOUT_MS))
            .keep_alive_while_idle(true);
        let handshake = builder.handshake::<_, Body>(TokioIo::new(stream));
        let remaining = timeout.saturating_sub(started.elapsed());
        let (sender, connection) = match tokio::time::timeout(remaining, handshake).await {
            Ok(Ok(pair)) => pair,
            Ok(Err(error)) => return Err(connect_failed(&target, error.to_string())),
            Err(_) => {
                return Err(connect_failed(
                    &target,
                    format!("no connection was ready within {}ms", timeout.as_millis()),
                ));
            }
        };
        hyper::rt::Executor::execute(&tasks, async move {
            let _ = connection.await;
        });
        Ok(PeerChannel {
            channel: Http2Channel(sender),
            origin,
            tasks,
        })
    }
}

impl PeerLink for PeerChannel {
    fn is_usable(&self) -> bool {
        !self.channel.0.is_closed()
    }

    fn is_finished(&self) -> bool {
        self.tasks.is_finished()
    }

    fn shut_down(&self) {
        self.tasks.stop();
    }

    async fn closed(&self) {
        self.tasks.stopped().await;
    }
}
