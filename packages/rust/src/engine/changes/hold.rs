use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::Duration;

use super::ChangeTicket;
use super::drive::KeepCurrent;
use super::replaced;
use crate::engine::constants::ANALYSIS_HOLD_APPLY_INTERVAL_MS;
use crate::engine::durable::switch::SwitchFailure;
use crate::error::{NarsilError, Result};
use crate::format::metadata_parts::PendingAnalysis;

#[derive(Default)]
struct HoldState {
    built: bool,
    released: bool,
    stopped: bool,
    ready: Option<Result<()>>,
    finished: Option<Result<()>>,
}

/// An analysis change whose new terms wait beside the old ones until the cluster's controller publishes their
/// generation, which releases the change to switch, or until a drop, a later change, or a restore stops it.
pub(crate) struct HeldRun {
    pub(crate) pending: PendingAnalysis,
    state: Mutex<HoldState>,
    changed: Condvar,
}

impl HeldRun {
    pub(crate) fn new(pending: PendingAnalysis) -> HeldRun {
        HeldRun {
            pending,
            state: Mutex::new(HoldState::default()),
            changed: Condvar::new(),
        }
    }

    fn state(&self) -> MutexGuard<'_, HoldState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Reports whether the new terms of the change are built and wait for the release.
    pub(crate) fn is_built(&self) -> bool {
        self.state().built
    }

    /// Lets the change switch to its new terms.
    pub(crate) fn release(&self) {
        self.state().released = true;
        self.changed.notify_all();
    }

    /// Asks the change to end without a switch.
    pub(crate) fn stop(&self) {
        self.state().stopped = true;
        self.changed.notify_all();
    }

    /// Reports whether a drop, a later change, or a close asked the change to stop.
    pub(crate) fn is_stopped(&self) -> bool {
        self.state().stopped
    }

    /// Records how the change ended, which also refuses the wait for its new terms where they were never built.
    pub(crate) fn finish(&self, outcome: Result<()>) {
        let mut state = self.state();
        state.built = false;
        if state.ready.is_none() {
            state.ready = Some(outcome.clone());
        }
        state.finished = Some(outcome);
        self.changed.notify_all();
    }

    /// Waits until the new terms of the change are built, and fails with the error that ended the change before.
    pub(crate) fn wait_ready(&self) -> Result<()> {
        let mut state = self.state();
        loop {
            if let Some(ready) = &state.ready {
                return ready.clone();
            }
            state = self
                .changed
                .wait(state)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }

    /// Waits until the change ends, and returns how it ended.
    pub(crate) fn wait_finished(&self) -> Result<()> {
        let mut state = self.state();
        loop {
            if let Some(finished) = &state.finished {
                return finished.clone();
            }
            state = self
                .changed
                .wait(state)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }

    /// Marks the new terms built, then keeps them current with every write until the release arrives, and fails
    /// with `ANALYSIS_CHANGE_REPLACED` where a drop, a later change, a close, or a restore stops the change first.
    pub(crate) fn wait_for_release(
        &self,
        ticket: &ChangeTicket<'_>,
        index_name: &str,
        keep_current: &mut KeepCurrent<'_>,
    ) -> Result<(), SwitchFailure> {
        {
            let mut state = self.state();
            state.built = true;
            state.ready = Some(Ok(()));
        }
        self.changed.notify_all();
        let interval = Duration::from_millis(ANALYSIS_HOLD_APPLY_INTERVAL_MS);
        loop {
            let (released, stopped) = {
                let state = self.state();
                (state.released, state.stopped)
            };
            if released {
                return Ok(());
            }
            if stopped || ticket.stopped() {
                return Err(self.unbuilt(replaced(index_name)));
            }
            if let Err(failure) = keep_current() {
                self.state().built = false;
                return Err(failure);
            }
            let state = self.state();
            if !state.released && !state.stopped {
                let _ = self
                    .changed
                    .wait_timeout(state, interval)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
            }
        }
    }

    fn unbuilt(&self, error: NarsilError) -> SwitchFailure {
        self.state().built = false;
        SwitchFailure::BeforeCommit(error)
    }
}
