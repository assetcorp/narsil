use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::{TokioIo, TokioTimer};
use narsil::{ErrorCode, Narsil, NarsilError};
use tokio::net::TcpListener;
use tokio::sync::{Mutex, watch};
use tokio::task::JoinHandle;

use crate::constants::{
    CONNECTION_IDLE_TIMEOUT_MS, DEFAULT_HOST, DEFAULT_PORT, SERVER_CLOSE_DRAIN_DEADLINE_MS,
};
use crate::errors::config_invalid_error;
use crate::feeds::Feeds;
use crate::http::budget::{BodyBudget, RequestGate};
use crate::http::cors::ResolvedCors;
use crate::http::in_flight::RequestsInFlight;
use crate::http::pipeline::serve;
use crate::http::stall_guard::WriteStallGuard;
use crate::ids::random_uuid;
use crate::options::ServerOptions;
use crate::state::{
    ResolvedBuild, ServerState, check_limits, check_secure_binding, resolve_limits,
};
use crate::tasks::{InMemoryTaskStore, TaskRegistry};

struct Running {
    address: SocketAddr,
    stop: watch::Sender<bool>,
    accepting: JoinHandle<()>,
}

/// An HTTP server for one Narsil engine, which serves the routes, limits, and error codes of the TypeScript
/// server's `createServer`.
///
/// The caller builds and owns the engine and hands it in. The server shares it across requests, and
/// [`NarsilServer::close`] leaves it open, while [`NarsilServer::shutdown`] also shuts it down.
pub struct NarsilServer {
    state: Arc<ServerState>,
    host: String,
    port: u16,
    options: ServerOptions,
    running: Mutex<Option<Running>>,
}

impl NarsilServer {
    /// Returns a server for `engine` with `options`, after registering the options' embedding and rerank adapters
    /// on the engine.
    ///
    /// # Errors
    ///
    /// Returns `CONFIG_INVALID` where a limit or a feed setting holds a value outside its range, and the engine's
    /// error where it refuses an adapter.
    pub fn new(engine: Arc<Narsil>, options: ServerOptions) -> Result<NarsilServer, NarsilError> {
        check_limits(&options.limits, engine.max_rerank_window() as u64)?;
        let feeds = Feeds::of(&options)?;
        for (name, adapter) in &options.embedding_adapters {
            engine.register_embedding_adapter(name, Arc::clone(adapter))?;
        }
        for (name, adapter) in &options.rerank_adapters {
            engine.register_rerank_adapter(name, Arc::clone(adapter))?;
        }
        let limits = resolve_limits(&engine, &options.limits);
        let instance_id = match &options.instance_id {
            Some(id) => id.clone(),
            None => random_uuid().ok_or_else(|| {
                config_invalid_error("The system offers no source of random numbers")
            })?,
        };
        let store = options
            .task_store
            .clone()
            .unwrap_or_else(|| Arc::new(InMemoryTaskStore::default()));
        let tasks = Arc::new(TaskRegistry::new(
            store,
            instance_id,
            limits.max_concurrent_tasks,
        ));
        let max_requests = usize::try_from(limits.max_concurrent_requests).unwrap_or(usize::MAX);
        let state = ServerState {
            engine,
            tasks,
            allow_regex: options.allow_regex.unwrap_or(true),
            ready: AtomicBool::new(false),
            build: ResolvedBuild {
                version: options
                    .build
                    .version
                    .clone()
                    .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string()),
                git_sha: options.build.git_sha.clone(),
                dirty: options.build.dirty,
            },
            cors: options.cors.as_ref().map(ResolvedCors::of),
            hook: options.on_request.clone(),
            identify: options.query_suggestions_identify.clone(),
            gate: RequestGate::new(max_requests),
            body_budget: BodyBudget::new(limits.max_body_bytes_in_flight),
            requests: RequestsInFlight::new(),
            feeds,
            limits,
        };
        Ok(NarsilServer {
            state: Arc::new(state),
            host: options
                .host
                .clone()
                .unwrap_or_else(|| DEFAULT_HOST.to_string()),
            port: options.port.unwrap_or(DEFAULT_PORT),
            options,
            running: Mutex::new(None),
        })
    }

    /// Binds to the configured address and starts answering requests, after reconciling the task store.
    ///
    /// # Errors
    ///
    /// Returns `CONFIG_INVALID` where the server binds to an address other than loopback with no request check
    /// and without `allow_insecure`, or where a feed is on with no request check, and `INTERNAL_ERROR`-free
    /// `CONFIG_INVALID` where the address cannot be bound.
    pub async fn listen(&self) -> Result<(), NarsilError> {
        let mut running = self.running.lock().await;
        if running.is_some() {
            return Ok(());
        }
        self.state.feeds.check_authentication(&self.options)?;
        check_secure_binding(&self.host, &self.options)?;
        let listener = TcpListener::bind((self.host.as_str(), self.port))
            .await
            .map_err(|failure| {
                config_invalid_error(format!(
                    "Failed to listen on {}:{}: {failure}",
                    self.host, self.port
                ))
            })?;
        let address = listener.local_addr().map_err(|failure| {
            config_invalid_error(format!("Failed to read the bound address: {failure}"))
        })?;
        let (stop, stopped) = watch::channel(false);
        let accepting = tokio::spawn(accept_loop(Arc::clone(&self.state), listener, stopped));
        *running = Some(Running {
            address,
            stop,
            accepting,
        });
        drop(running);
        self.state.tasks.reconcile().await;
        self.state.ready.store(true, Ordering::Release);
        Ok(())
    }

    /// Stops accepting connections, closes every feed, and waits up to 30 seconds for the requests in progress,
    /// leaving the running tasks and the engine open.
    pub async fn close(&self) {
        self.state.ready.store(false, Ordering::Release);
        let Some(running) = self.running.lock().await.take() else {
            return;
        };
        self.state.feeds.close().await;
        let _ = running.stop.send(true);
        let _ = running.accepting.await;
    }

    /// Closes the server as [`NarsilServer::close`] does, stops every running task and waits for it, then shuts the
    /// engine down.
    ///
    /// # Errors
    ///
    /// Returns the engine's error where its shutdown fails.
    pub async fn shutdown(&self) -> Result<(), NarsilError> {
        self.close().await;
        self.state.tasks.shutdown().await;
        let engine = Arc::clone(&self.state.engine);
        tokio::task::spawn_blocking(move || engine.shutdown())
            .await
            .map_err(|_| {
                NarsilError::new(ErrorCode::INSTANCE_SHUT_DOWN, "The engine shutdown stopped")
            })?
    }

    /// Returns the port that the server listens on, or `None` before [`NarsilServer::listen`] and after
    /// [`NarsilServer::close`].
    pub async fn listening_port(&self) -> Option<u16> {
        self.running
            .lock()
            .await
            .as_ref()
            .map(|running| running.address.port())
    }
}

async fn serve_connection(
    state: Arc<ServerState>,
    stream: tokio::net::TcpStream,
    remote: SocketAddr,
    mut stopped: watch::Receiver<bool>,
) {
    let service = service_fn(move |request| {
        let state = Arc::clone(&state);
        async move { Ok::<_, std::convert::Infallible>(serve(state, request, remote).await) }
    });
    let connection = http1::Builder::new()
        .timer(TokioTimer::new())
        .header_read_timeout(Duration::from_millis(CONNECTION_IDLE_TIMEOUT_MS))
        .serve_connection(TokioIo::new(WriteStallGuard::new(stream)), service)
        .with_upgrades();
    tokio::pin!(connection);
    tokio::select! {
        _ = connection.as_mut() => return,
        _ = stopped.wait_for(|stop| *stop) => {}
    }
    connection.as_mut().graceful_shutdown();
    let _ = connection.await;
}

async fn accept_loop(
    state: Arc<ServerState>,
    listener: TcpListener,
    mut stopped: watch::Receiver<bool>,
) {
    let mut connections = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            changed = stopped.changed() => {
                if changed.is_err() || *stopped.borrow() {
                    break;
                }
            }
            accepted = listener.accept() => {
                let Ok((stream, remote)) = accepted else { continue };
                let _ = stream.set_nodelay(true);
                while connections.try_join_next().is_some() {}
                connections.spawn(serve_connection(Arc::clone(&state), stream, remote, stopped.clone()));
            }
        }
    }
    drop(listener);
    let deadline = Duration::from_millis(SERVER_CLOSE_DRAIN_DEADLINE_MS);
    let drained = tokio::time::timeout(deadline, async {
        while connections.join_next().await.is_some() {}
        state.requests.settled().await;
    })
    .await;
    if drained.is_err() {
        connections.abort_all();
        while connections.join_next().await.is_some() {}
    }
}
