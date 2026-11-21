use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock, Weak};

use super::ListenHandler;

type Registered = (u64, ListenHandler);

#[derive(Default)]
pub(crate) struct HandlerSlot {
    current: RwLock<Option<Registered>>,
    next_id: AtomicU64,
}

impl HandlerSlot {
    pub(crate) fn current(&self) -> Option<ListenHandler> {
        let guard = self
            .current
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.as_ref().map(|(_, handler)| Arc::clone(handler))
    }

    pub(crate) fn replace(self: &Arc<HandlerSlot>, handler: ListenHandler) -> Listening {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut guard = self
            .current
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let previous = guard.replace((id, handler));
        Listening {
            slot: Arc::downgrade(self),
            id,
            previous,
        }
    }

    pub(crate) fn clear(&self) {
        let mut guard = self
            .current
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *guard = None;
    }
}

/// The registration of one listen handler, which [`Listening::stop`] removes.
pub struct Listening {
    slot: Weak<HandlerSlot>,
    id: u64,
    previous: Option<Registered>,
}

impl Listening {
    /// Removes the handler where it is still the one that the transport calls, which restores the handler that it
    /// replaced, and does nothing where a later call to `listen` replaced it.
    pub fn stop(self) {
        let Some(slot) = self.slot.upgrade() else {
            return;
        };
        let mut guard = slot
            .current
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if guard.as_ref().is_some_and(|(id, _)| *id == self.id) {
            *guard = self.previous;
        }
    }
}
