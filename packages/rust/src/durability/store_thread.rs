use std::sync::Arc;
use std::time::{Duration, Instant};

use super::constants::DIRECTORY_IDENTITY_CHECK_INTERVAL_MS;
use super::store_config::DurabilityMode;
use super::store_inner::StoreInner;

/// Flushes every log on the interval of the asynchronous durability mode and checks the directory's identity,
/// until the store stops or fails.
pub(crate) fn run_background(inner: Arc<StoreInner>) {
    let flushes = inner.config.mode == DurabilityMode::Async && inner.config.flush_interval_ms > 0;
    let flush_every = Duration::from_millis(inner.config.flush_interval_ms);
    let verify_every = Duration::from_millis(DIRECTORY_IDENTITY_CHECK_INTERVAL_MS);
    let tick = if flushes {
        flush_every.min(verify_every)
    } else {
        verify_every
    };
    let (mut flushed_at, mut verified_at) = (Instant::now(), Instant::now());
    loop {
        if inner.wait_for_stop(tick) || inner.fatal_error().is_some() {
            return;
        }
        if flushes && flushed_at.elapsed() >= flush_every {
            if let Ok(logs) = inner.every_log() {
                let _ = inner.flush_logs(&logs);
            }
            flushed_at = Instant::now();
        }
        if verified_at.elapsed() >= verify_every {
            let _ = inner.verify();
            verified_at = Instant::now();
        }
    }
}
