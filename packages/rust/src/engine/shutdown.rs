use std::sync::atomic::Ordering;

use super::durable::Durable;
use super::{Narsil, callback_scope};
use crate::error::{ErrorCode, NarsilError, Result};

impl Narsil {
    /// Stops the engine, after which a call on an index fails with `INSTANCE_SHUT_DOWN`, `list_indexes` returns an
    /// empty list, and a later `shutdown` returns `Ok`.
    ///
    /// A search that is still checking pattern tests, phrases, or a paged vector graph when shutdown begins stops
    /// within the next 65,536 units of its work and fails with `INSTANCE_SHUT_DOWN` too. An index create, restore,
    /// or reopen that is about to put its index in the engine finishes first, so that index closes with the others,
    /// and one that reaches that step later fails with `INSTANCE_SHUT_DOWN`. A durable engine first flushes every
    /// log to the disk and releases its directory, and fails with `PERSISTENCE_SAVE_FAILED` where that flush fails;
    /// the engine stops either way. A call from another thread while a shutdown is under way returns once that
    /// shutdown finishes. A call from an event listener or a plugin hook of this engine returns at once while
    /// another shutdown is under way, because that shutdown can be waiting for the thread that runs the callback.
    /// A call from inside a method of the engine's persistence adapter, or from a callback that an index create,
    /// restore, or reopen runs while it puts its index in the engine, fails with `CONFIG_INVALID` and changes nothing
    /// that a shutdown changes, because it would wait for the engine call that runs it to finish. The same refusal
    /// applies to a callback inside a read, because shutdown waits for reads before releasing files. A shutdown that
    /// another thread began goes on, and finishes once that engine call does. Once shutdown begins, a read that
    /// waits for a restore or for this shutdown to drain the searches of an index fails with `INSTANCE_SHUT_DOWN`
    /// at once, and [`Narsil::list_indexes`] returns an empty list, so that neither call waits for a search that
    /// can depend on it.
    pub fn shutdown(&self) -> Result<()> {
        let inside_adapter_call = self
            .inner
            .durable
            .as_ref()
            .is_some_and(Durable::calling_adapter_on_current_thread);
        if inside_adapter_call
            || self.inner.shutdown_gate.admitted_on_current_thread()
            || callback_scope::dispatching_on_current_thread(&self.inner.lifecycle)
        {
            return Err(NarsilError::new(
                ErrorCode::CONFIG_INVALID,
                "A callback asked the engine to shut down while the engine call that runs it waits to finish, so the engine refuses the call instead of waiting for itself",
            ));
        }
        let inside_callback = callback_scope::dispatching_on_current_thread(&self.inner.events)
            || callback_scope::dispatching_on_current_thread(&self.inner.plugins);
        let turn = self
            .inner
            .shutdown_gate
            .turn(&self.inner.shut_down, inside_callback);
        let Some(_turn) = turn else {
            return Ok(());
        };
        self.inner.search_limits.stop.stop_every_search();
        self.inner.suggestions.stop(&self.inner);
        self.inner.shut_down.store(true, Ordering::Release);
        for index in self.inner.index_list() {
            index.residency.wake_waiters();
        }
        self.inner.shutdown_gate.await_admitted();
        self.inner.lifecycle.sweeper.stop();
        let indexes = std::mem::take(&mut *self.inner.indexes_mut());
        for index in indexes.values() {
            index.residency.begin_swap();
            let writer = index.write_lock();
            index.retire();
            index.empty_partitions();
            index.vectors.release_files();
            drop(writer);
            index.residency.wake_waiters();
        }
        self.inner.lifecycle.clear();
        let closed = match &self.inner.durable {
            Some(durable) => durable.close(),
            None => Ok(()),
        };
        drop(indexes);
        self.inner.adapters.clear();
        closed
    }
}
