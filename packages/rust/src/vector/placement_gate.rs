use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{RwLock, RwLockReadGuard, RwLockWriteGuard};

pub(crate) struct PlacementGate {
    gate: RwLock<()>,
    placed_since_connect: AtomicBool,
}

impl PlacementGate {
    pub(crate) fn new() -> Self {
        PlacementGate {
            gate: RwLock::new(()),
            placed_since_connect: AtomicBool::new(false),
        }
    }

    pub(crate) fn carried(&self) -> Self {
        PlacementGate {
            gate: RwLock::new(()),
            placed_since_connect: AtomicBool::new(self.placed_since_connect()),
        }
    }

    pub(crate) fn admit_placement(&self) -> RwLockReadGuard<'_, ()> {
        self.gate
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn hold_placements_back(&self) -> RwLockWriteGuard<'_, ()> {
        self.gate
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn note_placement(&self) {
        if !self.placed_since_connect() {
            self.placed_since_connect.store(true, Ordering::Release);
        }
    }

    pub(crate) fn note_connected(&self) {
        self.placed_since_connect.store(false, Ordering::Release);
    }

    pub(crate) fn placed_since_connect(&self) -> bool {
        self.placed_since_connect.load(Ordering::Acquire)
    }
}
