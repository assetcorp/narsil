use super::query::constants::{
    DEFAULT_MAX_RERANK_WINDOW, MAX_RERANK_TIMEOUT_MS, MAX_RERANK_WINDOW, MIN_RERANK_TIMEOUT_MS,
    MIN_RERANK_WINDOW, RERANK_TIMEOUT_MS,
};
use crate::error::{ErrorCode, NarsilError, Result};

/// How long the engine waits for a rerank adapter, and the most hits that one query may rerank.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RerankSettings {
    pub(crate) timeout_ms: u64,
    pub(crate) max_window: usize,
}

impl Default for RerankSettings {
    fn default() -> RerankSettings {
        RerankSettings {
            timeout_ms: RERANK_TIMEOUT_MS,
            max_window: DEFAULT_MAX_RERANK_WINDOW,
        }
    }
}

impl RerankSettings {
    /// Checks `rerankTimeout` and `maxRerankWindow`, raising `CONFIG_INVALID` for a value outside its range.
    pub(crate) fn checked(
        timeout_ms: Option<u64>,
        max_window: Option<usize>,
    ) -> Result<RerankSettings> {
        if let Some(timeout) = timeout_ms
            && !(MIN_RERANK_TIMEOUT_MS..=MAX_RERANK_TIMEOUT_MS).contains(&timeout)
        {
            return Err(NarsilError::new(
                ErrorCode::CONFIG_INVALID,
                format!(
                    "rerankTimeout must be a whole number of milliseconds from {MIN_RERANK_TIMEOUT_MS} to {MAX_RERANK_TIMEOUT_MS}"
                ),
            ));
        }
        if let Some(window) = max_window
            && !(MIN_RERANK_WINDOW..=MAX_RERANK_WINDOW).contains(&window)
        {
            return Err(NarsilError::new(
                ErrorCode::CONFIG_INVALID,
                format!(
                    "maxRerankWindow must be a whole number from {MIN_RERANK_WINDOW} to {MAX_RERANK_WINDOW}"
                ),
            ));
        }
        let defaults = RerankSettings::default();
        Ok(RerankSettings {
            timeout_ms: timeout_ms.unwrap_or(defaults.timeout_ms),
            max_window: max_window.unwrap_or(defaults.max_window),
        })
    }
}
