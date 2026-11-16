use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};

use tokio::sync::Notify;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PendingSignals {
    pub(crate) advance: bool,
    pub(crate) settings: bool,
    pub(crate) resync_epoch: bool,
    pub(crate) close: Option<(u16, &'static str)>,
}

#[derive(Default)]
pub(crate) struct SessionSignals {
    pending: Mutex<PendingSignals>,
    filtered: AtomicBool,
    pub(crate) routine: Notify,
    pub(crate) urgent: Notify,
}

impl SessionSignals {
    fn pending(&self) -> MutexGuard<'_, PendingSignals> {
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn advance(&self) {
        self.pending().advance = true;
        self.routine.notify_one();
    }

    pub(crate) fn settings(&self) {
        self.pending().settings = true;
        self.routine.notify_one();
    }

    pub(crate) fn resync_epoch(&self) {
        self.pending().resync_epoch = true;
        self.urgent.notify_one();
    }

    pub(crate) fn close(&self, code: u16, reason: &'static str) {
        {
            let mut pending = self.pending();
            if pending.close.is_none() {
                pending.close = Some((code, reason));
            }
        }
        self.urgent.notify_one();
    }

    pub(crate) fn close_if_filtered(&self, code: u16, reason: &'static str) {
        if self.filtered.load(Ordering::Acquire) {
            self.close(code, reason);
        }
    }

    pub(crate) fn mark_filtered(&self) {
        self.filtered.store(true, Ordering::Release);
    }

    pub(crate) fn wake(&self) {
        self.urgent.notify_one();
    }

    pub(crate) fn take(&self) -> PendingSignals {
        std::mem::take(&mut *self.pending())
    }
}
