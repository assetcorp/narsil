use std::sync::atomic::{AtomicI64, Ordering};

use jiff::Timestamp;
use jiff::tz::TimeZone;

static LATEST_STARTED_AT_MS: AtomicI64 = AtomicI64::new(0);

fn iso_text(milliseconds: i64) -> String {
    let instant = Timestamp::from_millisecond(milliseconds).unwrap_or(Timestamp::UNIX_EPOCH);
    let civil = instant.to_zoned(TimeZone::UTC).datetime();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        civil.year(),
        civil.month(),
        civil.day(),
        civil.hour(),
        civil.minute(),
        civil.second(),
        civil.millisecond()
    )
}

/// Returns the start time that a registration records, in the ISO 8601 form that JavaScript's `toISOString`
/// writes, one millisecond after the last one that this process returned where the clock has not moved past it, so
/// that a peer can tell a node that restarted from the registration that it replaced.
pub fn next_started_at() -> String {
    let now = Timestamp::now().as_millisecond();
    let mut latest = LATEST_STARTED_AT_MS.load(Ordering::Acquire);
    loop {
        let next = now.max(latest + 1);
        match LATEST_STARTED_AT_MS.compare_exchange(
            latest,
            next,
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            Ok(_) => return iso_text(next),
            Err(current) => latest = current,
        }
    }
}
