use std::sync::atomic::{AtomicU16, AtomicUsize, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use narsil::Value;
use tokio::net::TcpListener;
use tokio::sync::watch;
use tokio_rustls::rustls::ServerConfig;

use super::io::{PeerStream, accept};
use super::listener::HandlerSlot;
use super::{BoxFuture, ListenHandler, Listening};
use crate::constants::ACCEPT_RETRY_DELAY_MS;
use crate::error::{ClusterError, ClusterResult, codes};

pub(crate) type ServerTls = Arc<RwLock<Option<Arc<ServerConfig>>>>;

pub(crate) type ServeConnection =
    Arc<dyn Fn(PeerStream, watch::Receiver<bool>) -> BoxFuture<'static, ()> + Send + Sync>;

pub(crate) struct AcceptSettings {
    pub(crate) max_connections: usize,
    pub(crate) handshake_timeout: Duration,
    pub(crate) tls: ServerTls,
}

pub(crate) async fn bind(host: &str, port: u16) -> ClusterResult<TcpListener> {
    TcpListener::bind((host, port)).await.map_err(|error| {
        ClusterError::new(
            codes::TRANSPORT_CONNECT_FAILED,
            format!("The transport failed to listen on {host}:{port}: {error}"),
        )
        .with_detail("address", Value::String(format!("{host}:{port}")))
    })
}

struct ConnectionSlot(Arc<AtomicUsize>);

impl Drop for ConnectionSlot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

fn claim_slot(open: &Arc<AtomicUsize>, limit: usize) -> Option<ConnectionSlot> {
    let slot = ConnectionSlot(Arc::clone(open));
    let earlier = open.fetch_add(1, Ordering::AcqRel);
    (earlier < limit).then_some(slot)
}

pub(crate) struct ListenSettings {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) max_connections: usize,
    pub(crate) handshake_timeout: Duration,
}

pub(crate) struct Listener {
    settings: ListenSettings,
    pub(crate) handlers: Arc<HandlerSlot>,
    pub(crate) tls: ServerTls,
    bound: tokio::sync::Mutex<bool>,
    port: AtomicU16,
    stop: watch::Sender<bool>,
}

impl Listener {
    pub(crate) fn new(settings: ListenSettings, tls: Option<Arc<ServerConfig>>) -> Listener {
        Listener {
            settings,
            handlers: Arc::new(HandlerSlot::default()),
            tls: Arc::new(RwLock::new(tls)),
            bound: tokio::sync::Mutex::new(false),
            port: AtomicU16::new(0),
            stop: watch::channel(false).0,
        }
    }

    pub(crate) fn port(&self) -> u16 {
        self.port.load(Ordering::Acquire)
    }

    pub(crate) async fn listen<S>(
        &self,
        handler: ListenHandler,
        serve: S,
    ) -> ClusterResult<Listening>
    where
        S: Fn(Arc<HandlerSlot>, PeerStream, watch::Receiver<bool>) -> BoxFuture<'static, ()>
            + Send
            + Sync
            + 'static,
    {
        let mut bound = self.bound.lock().await;
        if !*bound {
            let listener = bind(&self.settings.host, self.settings.port).await?;
            let port = listener
                .local_addr()
                .map(|address| address.port())
                .unwrap_or(self.settings.port);
            let handlers = Arc::clone(&self.handlers);
            let serve: ServeConnection =
                Arc::new(move |stream, stop| serve(Arc::clone(&handlers), stream, stop));
            let settings = AcceptSettings {
                max_connections: self.settings.max_connections,
                handshake_timeout: self.settings.handshake_timeout,
                tls: Arc::clone(&self.tls),
            };
            spawn_accept_loop(listener, settings, self.stop.subscribe(), serve);
            self.port.store(port, Ordering::Release);
            *bound = true;
        }
        Ok(self.handlers.replace(handler))
    }

    pub(crate) fn close(&self) {
        self.stop.send_replace(true);
        self.handlers.clear();
    }
}

pub(crate) fn spawn_accept_loop(
    listener: TcpListener,
    settings: AcceptSettings,
    mut shutdown: watch::Receiver<bool>,
    serve: ServeConnection,
) {
    let open = Arc::new(AtomicUsize::new(0));
    tokio::spawn(async move {
        loop {
            let accepted = tokio::select! {
                accepted = listener.accept() => accepted,
                _ = shutdown.wait_for(|stopped| *stopped) => return,
            };
            let Ok((socket, _)) = accepted else {
                tokio::time::sleep(Duration::from_millis(ACCEPT_RETRY_DELAY_MS)).await;
                continue;
            };
            let Some(slot) = claim_slot(&open, settings.max_connections) else {
                drop(socket);
                continue;
            };
            let tls = settings
                .tls
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone();
            let handshake_timeout = settings.handshake_timeout;
            let serve = Arc::clone(&serve);
            let stop = shutdown.clone();
            tokio::spawn(async move {
                let _slot = slot;
                if let Some(stream) = accept(socket, tls, handshake_timeout).await {
                    serve(stream, stop).await;
                }
            });
        }
    });
}
