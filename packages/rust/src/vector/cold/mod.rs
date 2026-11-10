mod field;
mod layout;
mod load;
mod open;
mod scan;
mod search;
mod walk;
mod writes;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, RwLock, RwLockWriteGuard};

use crate::config::{Quantization, Storage};
use crate::error::{NarsilError, Result};

use super::field::{Shared, VectorField};
use super::settings::VectorSettings;

pub(crate) use field::ColdField;
pub(crate) use load::GraphPartsReader;
pub(crate) use open::{ColdFieldInput, ColdFileInput, ColdGraphPartInput, open_cold_field};
pub(crate) use search::{ColdQuery, search_cold};

use writes::{HeldWrite, RetiredCopy};

enum Progress {
    Waiting,
    Loading,
    Ended,
    Cancelled,
    Failed(NarsilError),
}

struct HoldState {
    retired: HashMap<String, RetiredCopy>,
    writes: Vec<HeldWrite>,
    progress: Progress,
    load_wanted: bool,
    loader_runs: bool,
}

pub(crate) struct ColdHold {
    pub(crate) field: ColdField,
    held: VectorField,
    state: Mutex<HoldState>,
    changed: Condvar,
}

pub(crate) struct ColdSlot {
    occupied: AtomicBool,
    hold: RwLock<Option<Arc<ColdHold>>>,
}

impl ColdSlot {
    pub(crate) fn empty() -> ColdSlot {
        ColdSlot {
            occupied: AtomicBool::new(false),
            hold: RwLock::new(None),
        }
    }

    fn is_occupied(&self) -> bool {
        self.occupied.load(Ordering::Acquire)
    }

    fn held(&self) -> Option<Arc<ColdHold>> {
        if !self.is_occupied() {
            return None;
        }
        match self.hold.read() {
            Ok(held) => held.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        }
    }

    fn writing(&self) -> RwLockWriteGuard<'_, Option<Arc<ColdHold>>> {
        self.hold
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn replace(&self, hold: Option<Arc<ColdHold>>) -> Option<Arc<ColdHold>> {
        let mut held = self.writing();
        self.occupied.store(hold.is_some(), Ordering::Release);
        std::mem::replace(&mut *held, hold)
    }

    fn release(&self, hold: &Arc<ColdHold>) {
        let mut held = self.writing();
        if held.as_ref().is_some_and(|found| Arc::ptr_eq(found, hold)) {
            *held = None;
            self.occupied.store(false, Ordering::Release);
        }
    }
}

fn held_write_settings(settings: &VectorSettings) -> VectorSettings {
    VectorSettings {
        quantization: Quantization::None,
        storage: Storage::Memory,
        promotion_threshold: u64::MAX,
        ..settings.clone()
    }
}

impl ColdHold {
    fn lock(&self) -> MutexGuard<'_, HoldState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn wait<'a>(&self, state: MutexGuard<'a, HoldState>) -> MutexGuard<'a, HoldState> {
        self.changed
            .wait(state)
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn want_load(&self) {
        let mut state = self.lock();
        if !state.load_wanted {
            state.load_wanted = true;
            self.changed.notify_all();
        }
    }

    pub(crate) fn held_field(&self) -> &VectorField {
        &self.held
    }

    pub(crate) fn memory_bytes(&self) -> usize {
        let written: usize = self.lock().writes.iter().map(HeldWrite::memory_bytes).sum();
        self.field.resident_bytes() + self.held.memory_bytes() + written
    }
}

impl Shared {
    pub(crate) fn cold_hold(&self) -> Option<Arc<ColdHold>> {
        self.cold.held()
    }

    fn release_cold_hold(&self, hold: &Arc<ColdHold>) {
        self.cold.release(hold);
    }

    pub(crate) fn is_cold(&self) -> bool {
        self.cold.is_occupied()
    }

    pub(crate) fn cancel_cold_hold(&self, waits_for_loader: bool) {
        if !self.cold.is_occupied() {
            return;
        }
        let Some(hold) = self.cold.replace(None) else {
            return;
        };
        let mut state = hold.lock();
        if !matches!(state.progress, Progress::Ended | Progress::Failed(_)) {
            state.progress = Progress::Cancelled;
        }
        hold.changed.notify_all();
        while waits_for_loader && state.loader_runs {
            state = hold.wait(state);
        }
    }
}

impl VectorField {
    pub(crate) fn open_cold(&self, field: ColdField, read_graph: GraphPartsReader) -> Result<bool> {
        let shared = &self.shared;
        shared.cancel_cold_hold(true);
        let held = VectorField::new(
            held_write_settings(&shared.settings),
            Arc::clone(&shared.sequence),
        )?;
        let hold = Arc::new(ColdHold {
            field,
            held,
            state: Mutex::new(HoldState {
                retired: HashMap::new(),
                writes: Vec::new(),
                progress: Progress::Waiting,
                load_wanted: false,
                loader_runs: true,
            }),
            changed: Condvar::new(),
        });
        shared.cold.replace(Some(Arc::clone(&hold)));
        if load::start(Arc::clone(shared), Arc::clone(&hold), read_graph) {
            return Ok(true);
        }
        hold.lock().loader_runs = false;
        shared.cancel_cold_hold(false);
        Ok(false)
    }

    pub(crate) fn until_loaded(&self) -> Result<()> {
        while let Some(hold) = self.shared.cold_hold() {
            hold.want_load();
            let mut state = hold.lock();
            loop {
                match &state.progress {
                    Progress::Failed(error) => return Err(error.clone()),
                    Progress::Ended | Progress::Cancelled => break,
                    Progress::Waiting | Progress::Loading => state = hold.wait(state),
                }
            }
        }
        Ok(())
    }
}
