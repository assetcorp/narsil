use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};

use tokio::sync::{Notify, OwnedMutexGuard};

use super::handle::ClusterNode;
use crate::controller::lock;
use crate::error::ClusterResult;

type TransitionGate = Arc<tokio::sync::Mutex<()>>;

struct QueuedTransitions {
    gate: TransitionGate,
    queued: usize,
}

#[derive(Default)]
struct TrackerState {
    active_operations: usize,
    active_by_index: HashMap<String, usize>,
    transitions: HashMap<String, QueuedTransitions>,
}

#[derive(Default)]
pub(super) struct OperationTracker {
    state: Mutex<TrackerState>,
    index_drained: Notify,
    node_drained: Notify,
}

struct ActiveOperation<'a> {
    tracker: &'a OperationTracker,
}

impl Drop for ActiveOperation<'_> {
    fn drop(&mut self) {
        let mut state = lock(&self.tracker.state);
        state.active_operations -= 1;
        if state.active_operations == 0 {
            self.tracker.node_drained.notify_waiters();
        }
    }
}

struct IndexOperation<'a> {
    tracker: &'a OperationTracker,
    index_name: String,
}

impl Drop for IndexOperation<'_> {
    fn drop(&mut self) {
        let mut state = lock(&self.tracker.state);
        let remaining = state
            .active_by_index
            .get(&self.index_name)
            .map_or(0, |count| count.saturating_sub(1));
        if remaining > 0 {
            state
                .active_by_index
                .insert(self.index_name.clone(), remaining);
            return;
        }
        state.active_by_index.remove(&self.index_name);
        self.tracker.index_drained.notify_waiters();
    }
}

struct QueuedTransition<'a> {
    tracker: &'a OperationTracker,
    index_name: String,
    gate: TransitionGate,
}

impl Drop for QueuedTransition<'_> {
    fn drop(&mut self) {
        let mut state = lock(&self.tracker.state);
        let Some(queued) = state.transitions.get_mut(&self.index_name) else {
            return;
        };
        if !Arc::ptr_eq(&queued.gate, &self.gate) {
            return;
        }
        queued.queued -= 1;
        if queued.queued == 0 {
            state.transitions.remove(&self.index_name);
        }
    }
}

impl OperationTracker {
    fn begin(&self) -> ActiveOperation<'_> {
        lock(&self.state).active_operations += 1;
        ActiveOperation { tracker: self }
    }

    fn count_index(&self, state: &mut TrackerState, index_name: &str) -> IndexOperation<'_> {
        *state
            .active_by_index
            .entry(index_name.to_string())
            .or_insert(0) += 1;
        IndexOperation {
            tracker: self,
            index_name: index_name.to_string(),
        }
    }

    fn count_unless_transition(
        &self,
        index_name: &str,
    ) -> Result<IndexOperation<'_>, TransitionGate> {
        let mut state = lock(&self.state);
        if let Some(queued) = state.transitions.get(index_name) {
            return Err(Arc::clone(&queued.gate));
        }
        Ok(self.count_index(&mut state, index_name))
    }

    fn queue_transition(&self, index_name: &str) -> QueuedTransition<'_> {
        let mut state = lock(&self.state);
        let queued = state
            .transitions
            .entry(index_name.to_string())
            .or_insert_with(|| QueuedTransitions {
                gate: Arc::new(tokio::sync::Mutex::new(())),
                queued: 0,
            });
        queued.queued += 1;
        QueuedTransition {
            tracker: self,
            index_name: index_name.to_string(),
            gate: Arc::clone(&queued.gate),
        }
    }

    async fn wait_for_index_drain(&self, index_name: &str) {
        loop {
            let drained = self.index_drained.notified();
            tokio::pin!(drained);
            drained.as_mut().enable();
            if !lock(&self.state).active_by_index.contains_key(index_name) {
                return;
            }
            drained.await;
        }
    }

    pub(super) async fn drain(&self) {
        loop {
            let drained = self.node_drained.notified();
            tokio::pin!(drained);
            drained.as_mut().enable();
            if lock(&self.state).active_operations == 0 {
                return;
            }
            drained.await;
        }
    }

    pub(super) async fn track<T, F>(
        &self,
        index_name: Option<&str>,
        guard: impl Fn() -> ClusterResult<()>,
        assert_index: impl Fn(&str) -> ClusterResult<()>,
        action: F,
    ) -> ClusterResult<T>
    where
        F: Future<Output = ClusterResult<T>>,
    {
        guard()?;
        if let Some(name) = index_name {
            assert_index(name)?;
        }
        let _operation = self.begin();
        let _index_operation = match index_name {
            None => None,
            Some(name) => Some(match self.count_unless_transition(name) {
                Ok(counted) => {
                    assert_index(name)?;
                    counted
                }
                Err(gate) => {
                    drop(gate.lock().await);
                    assert_index(name)?;
                    self.count_index(&mut lock(&self.state), name)
                }
            }),
        };
        action.await
    }

    pub(super) async fn transition<T, F>(
        &self,
        index_name: &str,
        guard: impl Fn() -> ClusterResult<()>,
        action: F,
    ) -> ClusterResult<T>
    where
        F: Future<Output = ClusterResult<T>>,
    {
        guard()?;
        let _operation = self.begin();
        let queued = self.queue_transition(index_name);
        let _turn: OwnedMutexGuard<()> = Arc::clone(&queued.gate).lock_owned().await;
        self.wait_for_index_drain(index_name).await;
        action.await
    }
}

impl ClusterNode {
    fn assert_claimed(&self, index_name: &str) -> ClusterResult<()> {
        match &self.inner.data {
            Some(data) => data.refuse_orphaned_name(index_name),
            None => Ok(()),
        }
    }

    pub(super) async fn track<T>(
        &self,
        index_name: Option<&str>,
        action: impl Future<Output = ClusterResult<T>>,
    ) -> ClusterResult<T> {
        self.inner
            .operations
            .track(
                index_name,
                || self.guard_shutdown(),
                |name| self.assert_claimed(name),
                action,
            )
            .await
    }

    pub(super) async fn transition_index<T>(
        &self,
        index_name: &str,
        action: impl Future<Output = ClusterResult<T>>,
    ) -> ClusterResult<T> {
        self.inner
            .operations
            .transition(index_name, || self.guard_shutdown(), action)
            .await
    }
}
