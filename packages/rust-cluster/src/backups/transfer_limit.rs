use std::sync::{Condvar, Mutex};

use crate::controller::lock;

pub(crate) struct TransferLimit {
    running: Mutex<usize>,
    freed: Condvar,
    at_once: usize,
}

pub(crate) struct TransferTurn<'l> {
    limit: &'l TransferLimit,
}

impl TransferLimit {
    pub(crate) fn new(at_once: usize) -> TransferLimit {
        TransferLimit {
            running: Mutex::new(0),
            freed: Condvar::new(),
            at_once: at_once.max(1),
        }
    }

    pub(crate) fn turn(&self) -> TransferTurn<'_> {
        let mut running = lock(&self.running);
        while *running >= self.at_once {
            running = self
                .freed
                .wait(running)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        *running += 1;
        TransferTurn { limit: self }
    }
}

impl Drop for TransferTurn<'_> {
    fn drop(&mut self) {
        let mut running = lock(&self.limit.running);
        *running = running.saturating_sub(1);
        self.limit.freed.notify_one();
    }
}
