use std::collections::HashSet;
use std::sync::Mutex;
use std::sync::atomic::{AtomicI64, AtomicU32};

use super::constants::DEFAULT_PATTERN_WORK_CAP;
use crate::error::{ErrorCode, NarsilError};
use crate::ffi;

pub(crate) struct WorkMeter {
    cap: i64,
    spent: AtomicI64,
    stop: AtomicU32,
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
            stop: AtomicU32::new(0),
            prepared_typo_tests: Mutex::new(HashSet::new()),
        }
    }

    pub(crate) fn native(&self) -> ffi::narsil_work_meter {
        ffi::narsil_work_meter {
            spent: self.spent.as_ptr(),
            cap: self.cap,
            stop: self.stop.as_ptr(),
            deadline: 0,
        }
    }

    pub(crate) fn exceeded(&self) -> NarsilError {
        cap_exceeded(self.cap)
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
