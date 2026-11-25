use std::sync::atomic::{AtomicU8, Ordering};

use tokio::time::Instant;

const OPEN: u8 = 0;
const STARTED: u8 = 1;
const ABANDONED: u8 = 2;

pub(super) struct AttemptWindow {
    pub(super) deadline: Instant,
    state: AtomicU8,
}

impl AttemptWindow {
    pub(super) fn new(deadline: Instant) -> AttemptWindow {
        AttemptWindow {
            deadline,
            state: AtomicU8::new(OPEN),
        }
    }

    pub(super) fn closed(&self) -> bool {
        self.state.load(Ordering::Acquire) == ABANDONED || Instant::now() >= self.deadline
    }

    pub(super) fn start(&self) -> bool {
        if Instant::now() >= self.deadline {
            return false;
        }
        match self
            .state
            .compare_exchange(OPEN, STARTED, Ordering::AcqRel, Ordering::Acquire)
        {
            Ok(_) => true,
            Err(state) => state == STARTED,
        }
    }

    pub(super) fn abandon(&self) -> bool {
        self.state
            .compare_exchange(OPEN, ABANDONED, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }
}
