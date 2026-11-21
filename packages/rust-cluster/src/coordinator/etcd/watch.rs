use std::collections::{HashMap, HashSet};
use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Weak};
use std::time::Duration;

use etcd_client::{EventType, GetOptions, WatchOptions, WatchStream};
use narsil::Value;
use tokio::sync::watch;

use super::Inner;
use super::client::unreachable;
use super::endpoints::CallFailure;
use crate::constants::{
    ETCD_WATCH_ATTACH_TIMEOUT_MS, MAX_WATCHERS, RECONNECT_FIRST_DELAY_MS,
    RECONNECT_LONGEST_DELAY_MS,
};
use crate::error::{ClusterError, ClusterResult, codes};

pub(crate) type PutHandler = Box<dyn Fn(&str, &[u8]) -> ClusterResult<()> + Send + Sync>;
pub(crate) type DeleteHandler = Box<dyn Fn(&str) -> ClusterResult<()> + Send + Sync>;

pub(crate) struct PrefixHandlers {
    pub(crate) put: PutHandler,
    pub(crate) delete: DeleteHandler,
}

/// A running watch, which delivers every change under its prefix until [`WatchHandle::stop`] ends it or the
/// coordinator shuts down. Dropping the handle leaves the watch running.
pub struct WatchHandle {
    stop: watch::Sender<bool>,
}

struct WatchSlot {
    owner: Weak<Inner>,
    slot: u64,
}

impl Drop for WatchSlot {
    fn drop(&mut self) {
        if let Some(inner) = self.owner.upgrade() {
            inner.release_watch_slot(self.slot);
        }
    }
}

impl WatchHandle {
    /// Ends the watch, after which its handler receives no further change.
    pub fn stop(self) {
        self.stop.send_replace(true);
    }
}

struct PrefixState {
    prefix: String,
    mod_revisions: HashMap<String, i64>,
    handlers: PrefixHandlers,
    stopped: watch::Receiver<bool>,
}

fn attach_failure(message: String) -> ClusterError {
    ClusterError::new(codes::COORDINATOR_UNAVAILABLE, message)
}

fn report(inner: &Inner, outcome: std::thread::Result<ClusterResult<()>>) {
    let error = match outcome {
        Ok(Ok(())) => return,
        Ok(Err(error)) => error,
        Err(_) => ClusterError::new(codes::INTERNAL_ERROR, "A watch handler panicked"),
    };
    if let Some(on_watch_error) = &inner.on_watch_error {
        let _ = std::panic::catch_unwind(AssertUnwindSafe(|| on_watch_error(error)));
    }
}

impl PrefixState {
    fn put(&mut self, inner: &Inner, key: String, value: &[u8], mod_revision: i64) {
        if *self.stopped.borrow() || inner.is_shut_down() {
            return;
        }
        let outcome =
            std::panic::catch_unwind(AssertUnwindSafe(|| (self.handlers.put)(&key, value)));
        self.mod_revisions.insert(key, mod_revision);
        report(inner, outcome);
    }

    fn delete(&mut self, inner: &Inner, key: &str) {
        if *self.stopped.borrow() || inner.is_shut_down() {
            return;
        }
        self.mod_revisions.remove(key);
        let outcome = std::panic::catch_unwind(AssertUnwindSafe(|| (self.handlers.delete)(key)));
        report(inner, outcome);
    }

    async fn list(&mut self, inner: &Inner, report_missed: bool) -> ClusterResult<i64> {
        let listing = inner
            .get(
                "watchPrefix",
                self.prefix.as_bytes(),
                Some(GetOptions::new().with_prefix()),
            )
            .await?;
        let mut listed = HashSet::with_capacity(listing.kvs().len());
        for entry in listing.kvs() {
            let key = String::from_utf8_lossy(entry.key()).into_owned();
            listed.insert(key.clone());
            if !report_missed {
                self.mod_revisions.insert(key, entry.mod_revision());
            } else if self.mod_revisions.get(&key) != Some(&entry.mod_revision()) {
                self.put(inner, key, entry.value(), entry.mod_revision());
            }
        }
        if report_missed {
            let gone: Vec<String> = self
                .mod_revisions
                .keys()
                .filter(|key| !listed.contains(*key))
                .cloned()
                .collect();
            for key in gone {
                self.delete(inner, &key);
            }
        }
        let revision = listing.header().map_or(0, |header| header.revision());
        Ok(revision + 1)
    }
}

struct OpenWatch {
    stream: WatchStream,
    endpoint: usize,
}

async fn open_stream(inner: &Inner, prefix: &str, start_revision: i64) -> ClusterResult<OpenWatch> {
    let options = WatchOptions::new()
        .with_prefix()
        .with_start_revision(start_revision);
    let attach = async {
        let served = inner
            .pool
            .serve(|mut clients| {
                let key = prefix.as_bytes().to_vec();
                let options = options.clone();
                async move { clients.watch.watch(key, Some(options)).await }
            })
            .await
            .map_err(|failure| unreachable("watchPrefix", &failure))?;
        let mut stream = served.value;
        loop {
            match stream.message().await {
                Ok(Some(response)) if response.created() && response.canceled() => {
                    let reason = response.cancel_reason();
                    return Err(attach_failure(format!(
                        "etcd refused the watch: {}",
                        if reason.is_empty() {
                            "no reason given"
                        } else {
                            reason
                        }
                    )));
                }
                Ok(Some(response)) if response.created() => {
                    return Ok(OpenWatch {
                        stream,
                        endpoint: served.endpoint,
                    });
                }
                Ok(Some(_)) => {}
                Ok(None) => {
                    return Err(attach_failure(
                        "the etcd watch stream ended before etcd attached the watch".to_string(),
                    ));
                }
                Err(error) => {
                    let failure = CallFailure::Etcd(error);
                    inner.pool.report_failure(served.endpoint, &failure).await;
                    return Err(unreachable("watchPrefix", &failure));
                }
            }
        }
    };
    match tokio::time::timeout(Duration::from_millis(ETCD_WATCH_ATTACH_TIMEOUT_MS), attach).await {
        Ok(result) => result,
        Err(_) => Err(attach_failure(format!(
            "etcd did not attach the watch within {ETCD_WATCH_ATTACH_TIMEOUT_MS} ms"
        ))),
    }
}

async fn deliver_until_lost(
    inner: &Weak<Inner>,
    state: &mut PrefixState,
    open: &mut OpenWatch,
    stop: &mut watch::Receiver<bool>,
) -> bool {
    loop {
        let response = tokio::select! {
            response = open.stream.message() => response,
            _ = stop.wait_for(|stopped| *stopped) => return true,
        };
        let Some(held) = inner.upgrade() else {
            return true;
        };
        let response = match response {
            Ok(Some(response)) => response,
            Ok(None) => return held.is_shut_down(),
            Err(error) => {
                if !held.is_shut_down() {
                    held.pool
                        .report_failure(open.endpoint, &CallFailure::Etcd(error))
                        .await;
                }
                return held.is_shut_down();
            }
        };
        for event in response.events() {
            let Some(entry) = event.kv() else {
                continue;
            };
            let key = String::from_utf8_lossy(entry.key()).into_owned();
            match event.event_type() {
                EventType::Put => state.put(&held, key, entry.value(), entry.mod_revision()),
                EventType::Delete => state.delete(&held, &key),
            }
        }
        if response.canceled() {
            return held.is_shut_down();
        }
    }
}

async fn follow(
    inner: Weak<Inner>,
    mut state: PrefixState,
    first: Option<OpenWatch>,
    mut stop: watch::Receiver<bool>,
) {
    let mut stream = first;
    let mut delay = Duration::from_millis(RECONNECT_FIRST_DELAY_MS);
    loop {
        if let Some(open) = stream.as_mut()
            && deliver_until_lost(&inner, &mut state, open, &mut stop).await
        {
            return;
        }
        stream = None;
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = stop.wait_for(|stopped| *stopped) => return,
        }
        delay = (delay * 2).min(Duration::from_millis(RECONNECT_LONGEST_DELAY_MS));
        let Some(held) = inner.upgrade() else {
            return;
        };
        if held.is_shut_down() {
            return;
        }
        let reopened = async {
            let revision = state.list(&held, true).await?;
            open_stream(&held, &state.prefix, revision).await
        };
        let outcome = tokio::select! {
            outcome = reopened => outcome,
            _ = stop.wait_for(|stopped| *stopped) => return,
        };
        if let Ok(open) = outcome {
            stream = Some(open);
            delay = Duration::from_millis(RECONNECT_FIRST_DELAY_MS);
        }
    }
}

pub(crate) async fn watch_prefix(
    inner: &Arc<Inner>,
    prefix: String,
    handlers: PrefixHandlers,
) -> ClusterResult<WatchHandle> {
    inner.ensure_open()?;
    let (stop, stopped) = watch::channel(false);
    let slot = inner.claim_watch_slot(stop.clone())?;
    let slot = WatchSlot {
        owner: Arc::downgrade(inner),
        slot,
    };
    let mut state = PrefixState {
        prefix,
        mod_revisions: HashMap::new(),
        handlers,
        stopped: stopped.clone(),
    };
    let start_revision = state.list(inner, false).await?;
    let first = open_stream(inner, &state.prefix, start_revision).await.ok();
    let owner = Arc::downgrade(inner);
    tokio::spawn(async move {
        let _slot = slot;
        follow(owner, state, first, stopped).await;
    });
    Ok(WatchHandle { stop })
}

pub(crate) fn watcher_limit_error(current: usize) -> ClusterError {
    ClusterError::new(
        codes::CONFIG_INVALID,
        format!("Maximum watcher limit ({MAX_WATCHERS}) reached"),
    )
    .with_detail("currentCount", Value::Number(current as f64))
}
