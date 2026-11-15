use narsil::{ErrorCode, NarsilError};

use super::FeedKind;
use super::constants::{
    DEFAULT_FEED_WINDOW_BYTES, DEFAULT_MAX_FEED_BUFFERED_BYTES, DEFAULT_MAX_FEED_CATCH_UPS,
    DEFAULT_MAX_FEED_CONNECTIONS,
};
use crate::options::FeedOptions;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ResolvedFeedOptions {
    pub(crate) window_bytes: u64,
    pub(crate) max_connections: u64,
    pub(crate) max_catch_ups: u64,
    pub(crate) max_buffered_bytes: u64,
}

pub(crate) fn resolve(
    kind: FeedKind,
    options: Option<&FeedOptions>,
) -> Result<Option<ResolvedFeedOptions>, NarsilError> {
    let Some(options) = options else {
        return Ok(None);
    };
    let fields = [
        ("windowBytes", options.window_bytes),
        ("maxConnections", options.max_connections),
        ("maxCatchUps", options.max_catch_ups),
        ("maxBufferedBytes", options.max_buffered_bytes),
    ];
    for (field, value) in fields {
        if let Some(value) = value
            && value < 1
        {
            return Err(NarsilError::new(
                ErrorCode::CONFIG_INVALID,
                format!(
                    "{}.{field} must be a whole number of at least 1; however, this configuration sets it to {value}",
                    kind.name()
                ),
            ));
        }
    }
    Ok(Some(ResolvedFeedOptions {
        window_bytes: options.window_bytes.unwrap_or(DEFAULT_FEED_WINDOW_BYTES),
        max_connections: options
            .max_connections
            .unwrap_or(DEFAULT_MAX_FEED_CONNECTIONS),
        max_catch_ups: options.max_catch_ups.unwrap_or(DEFAULT_MAX_FEED_CATCH_UPS),
        max_buffered_bytes: options
            .max_buffered_bytes
            .unwrap_or(DEFAULT_MAX_FEED_BUFFERED_BYTES),
    }))
}
