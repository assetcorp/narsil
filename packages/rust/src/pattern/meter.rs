use std::collections::HashSet;
use std::sync::Mutex;
use std::sync::atomic::{AtomicI64, Ordering};

use super::constants::{DEFAULT_PATTERN_WORK_CAP, PATTERN_WORK_FLUSH_UNITS};
use crate::error::{ErrorCode, NarsilError, Result};

pub(crate) struct WorkMeter {
    cap: i64,
    spent: AtomicI64,
    prepared_typo_tests: Mutex<HashSet<String>>,
}

fn cap_exceeded(cap: i64) -> NarsilError {
    NarsilError::new(
        ErrorCode::SEARCH_WORK_CAP_EXCEEDED,
        format!(
            "The engine stopped this search before it checked every candidate, because the work on its pattern tests and phrases passed the cap of {cap} units. Narrow the tests or the phrases, or raise the patternWorkCap engine setting"
        ),
    )
}

impl Default for WorkMeter {
    fn default() -> WorkMeter {
        WorkMeter::new(DEFAULT_PATTERN_WORK_CAP)
    }
}

impl WorkMeter {
    pub(crate) fn new(cap: i64) -> WorkMeter {
        WorkMeter {
            cap,
            spent: AtomicI64::new(0),
            prepared_typo_tests: Mutex::new(HashSet::new()),
        }
    }

    pub(crate) fn spent(&self) -> i64 {
        self.spent.load(Ordering::Relaxed)
    }

    pub(crate) fn remaining(&self) -> i64 {
        self.cap.saturating_sub(self.spent())
    }

    pub(crate) fn add(&self, units: i64) -> Result<()> {
        if units <= 0 {
            return Ok(());
        }
        let total = self
            .spent
            .fetch_add(units, Ordering::Relaxed)
            .saturating_add(units);
        if total > self.cap {
            return Err(cap_exceeded(self.cap));
        }
        Ok(())
    }

    pub(crate) fn claim_typo_preparation(&self, key: &str) -> bool {
        let mut claimed = self
            .prepared_typo_tests
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if claimed.contains(key) {
            return false;
        }
        claimed.insert(key.to_string())
    }
}

pub(crate) struct WorkTally<'meter> {
    meter: &'meter WorkMeter,
    pending: i64,
    headroom: i64,
}

impl<'meter> WorkTally<'meter> {
    pub(crate) fn new(meter: &'meter WorkMeter) -> WorkTally<'meter> {
        WorkTally {
            meter,
            pending: 0,
            headroom: meter.remaining(),
        }
    }

    pub(crate) fn meter(&self) -> &'meter WorkMeter {
        self.meter
    }

    #[inline]
    pub(crate) fn add(&mut self, units: u64) -> Result<()> {
        self.pending = self
            .pending
            .saturating_add(units.min(i64::MAX as u64) as i64);
        if self.pending >= PATTERN_WORK_FLUSH_UNITS || self.pending > self.headroom {
            return self.flush();
        }
        Ok(())
    }

    pub(crate) fn flush(&mut self) -> Result<()> {
        if self.pending == 0 {
            return Ok(());
        }
        let units = self.pending;
        self.pending = 0;
        let added = self.meter.add(units);
        self.headroom = self.meter.remaining();
        added
    }
}
