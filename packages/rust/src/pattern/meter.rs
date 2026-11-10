use std::collections::HashSet;
use std::sync::atomic::{AtomicI64, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use crate::error::{ErrorCode, NarsilError, instance_shut_down};
use crate::ffi;

const SEARCHES_STOPPED: u32 = 1;

#[derive(Clone, Default)]
pub(crate) struct SearchStop(Arc<AtomicU32>);

impl SearchStop {
    pub(crate) fn stop_every_search(&self) {
        self.0.store(SEARCHES_STOPPED, Ordering::Release);
    }
}

#[derive(Clone)]
pub(crate) struct SearchLimits {
    pub(crate) work_cap: i64,
    pub(crate) stop: SearchStop,
}

impl SearchLimits {
    pub(crate) fn new(work_cap: i64) -> SearchLimits {
        SearchLimits {
            work_cap,
            stop: SearchStop::default(),
        }
    }
}

pub(crate) struct WorkMeter {
    cap: i64,
    spent: AtomicI64,
    stop: SearchStop,
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

impl WorkMeter {
    pub(crate) fn new(cap: i64, stop: SearchStop) -> WorkMeter {
        WorkMeter {
            cap,
            spent: AtomicI64::new(0),
            stop,
            prepared_typo_tests: Mutex::new(HashSet::new()),
        }
    }

    pub(crate) fn within(limits: &SearchLimits) -> WorkMeter {
        WorkMeter::new(limits.work_cap, limits.stop.clone())
    }

    pub(crate) fn stop(&self) -> &SearchStop {
        &self.stop
    }

    pub(crate) fn native(&self) -> ffi::narsil_work_meter {
        ffi::narsil_work_meter {
            spent: self.spent.as_ptr(),
            cap: self.cap,
            stop: self.stop.0.as_ptr(),
            deadline: 0,
        }
    }

    pub(crate) fn refusal(&self, status: ffi::narsil_status) -> Option<NarsilError> {
        match status {
            ffi::NARSIL_WORK_CAP_EXCEEDED => Some(cap_exceeded(self.cap)),
            ffi::NARSIL_STOPPED => Some(instance_shut_down()),
            _ => None,
        }
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
